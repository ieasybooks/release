# Ieasybooks::Release::ReviewReplacement clears the way for a new App Store
# submission. App Store Connect keeps one
# review submission in progress per platform, and fastlane's deliver makes sure
# the App Store version exists (creating or renaming it) before it pulls an
# older submission out of review, which App Store Connect refuses while that
# one is waiting for review or in review. So the submit lane runs this first,
# once the new build has finished processing, and it alone cancels reviews:
#
# - nothing in review: nothing to do;
# - a newer version or build in review (an older release's job re-run after a
#   newer release): stop without cancelling it, since this release would
#   replace it;
# - this version and build already in review (a re-run): nothing to do, and
#   the lane doesn't submit it again;
# - this version and build returned with unresolved issues: stop, since only a
#   new version fixes that;
# - anything else in review: cancel it, and wait until App Store Connect has
#   finished (the submission is no longer cancelling and its version no
#   longer in review), up to a timeout that stops the lane before it submits.
#   A submission already cancelling is only waited for.
#
# Plain Ruby, so its tests run without fastlane or Apple: the store
# is anything with #pending, #cancel and #version_state, AppStoreReviews below
# for real.
module Ieasybooks
  module Release
    class ReviewReplacement
      Pending = Struct.new(:state, :version, :build, :version_id, :handle, keyword_init: true)

      class Error < StandardError; end

      UNRESOLVED_ISSUES = "UNRESOLVED_ISSUES"
      CANCELING = "CANCELING"
      # A version's states while it waits for review or is in review: App Store
      # Connect refuses to change it until it has left them.
      VERSION_IN_REVIEW = %w[WAITING_FOR_REVIEW IN_REVIEW].freeze

      def initialize(store:, version:, build:, timeout: 15 * 60, interval: 15,
                     clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) },
                     sleeper: ->(seconds) { sleep(seconds) },
                     log: ->(message) { puts(message) })
        @store = store
        @version = version.to_s
        @build = build.to_s
        @timeout = timeout
        @interval = interval
        @clock = clock
        @sleeper = sleeper
        @log = log
      end

      # What it found or did: :nothing_in_review, :already_submitted,
      # :would_cancel (a dry run) or :cancelled.
      def run(dry_run: false)
        pending = @store.pending
        if pending.nil?
          @log.call("Nothing is in review on the App Store.")
          return :nothing_in_review
        end

        if newer?(pending)
          raise Error, "#{describe(pending)} is newer than #{ours}, which would replace it; cancelled nothing. " \
                       "Release #{pending.version} or a later version instead."
        end

        if ours?(pending) && pending.state != CANCELING
          if pending.state == UNRESOLVED_ISSUES
            raise Error, "App Store review returned #{describe(pending)}. Fix the issues and release a new version."
          end
          @log.call("#{describe(pending)} is already submitted, so there's nothing to submit.")
          return :already_submitted
        end

        if dry_run
          if pending.state == CANCELING
            @log.call("Would wait for App Store Connect to finish pulling #{describe(pending)} out of review, then submit #{ours}.")
          else
            @log.call("Would pull #{describe(pending)} out of review so #{ours} replaces it.")
          end
          return :would_cancel
        end

        if pending.state == CANCELING
          @log.call("#{describe(pending)} is already being pulled out of review; waiting for it so #{ours} replaces it.")
        else
          @log.call("Pulling #{describe(pending)} out of review so #{ours} replaces it.")
          @store.cancel(pending)
        end
        wait_until_cancelled(pending)
        @log.call("The review is cancelled; #{ours} goes next.")
        :cancelled
      end

      private

      # Until no submission is in progress or cancelling, and the version that
      # was in review has left review.
      def wait_until_cancelled(cancelled)
        deadline = @clock.call + @timeout
        loop do
          waiting_for = waiting_for(cancelled)
          return if waiting_for.nil?

          if @clock.call >= deadline
            raise Error, "App Store Connect hasn't finished cancelling #{describe(cancelled)} #{@timeout / 60} minutes after " \
                         "the cancellation (#{waiting_for}); submitted nothing."
          end
          @log.call("Waiting for App Store Connect to cancel the review (#{waiting_for})...")
          @sleeper.call(@interval)
        end
      end

      def waiting_for(cancelled)
        still = @store.pending
        return "#{describe(still)} is still in progress" if still

        state = @store.version_state(cancelled)
        "#{cancelled.version} is still #{state}" if VERSION_IN_REVIEW.include?(state)
      end

      def ours?(pending)
        pending.version.to_s == @version && pending.build.to_s == @build
      end

      # Whether the submission's version, then its build, is past this
      # release's. Its build counts only for the same version.
      def newer?(pending)
        return false if pending.version.nil?

        theirs = [gem_version(pending.version), gem_version(pending.build)]
        (theirs <=> [gem_version(@version), gem_version(@build)]) == 1
      end

      def gem_version(value)
        Gem::Version.new(value.to_s)
      rescue ArgumentError
        raise Error, "Can't tell whether App Store Connect's #{value.inspect} is newer than #{ours}; cancelled nothing."
      end

      def ours
        "#{@version} (#{@build})"
      end

      def describe(pending)
        "#{pending.version || 'a version'} (#{pending.build || 'no build'}, #{pending.state})"
      end
    end

    # App Store Connect's review submission in progress or being cancelled,
    # through fastlane's spaceship: the version in it and that version's build.
    # fastlane's own get_in_progress_review_submission leaves out CANCELING, so
    # a submission still being cancelled would look like none; this asks for it
    # too.
    class AppStoreReviews
      IN_PROGRESS = %w[WAITING_FOR_REVIEW IN_REVIEW UNRESOLVED_ISSUES CANCELING].freeze

      def initialize(app, platform, versions: ->(id) { Spaceship::ConnectAPI::AppStoreVersion.get(app_store_version_id: id) })
        @app = app
        @platform = platform
        @versions = versions
      end

      def pending
        submission = @app.get_review_submissions(
          filter: { state: IN_PROGRESS.join(","), platform: @platform },
          includes: "appStoreVersionForReview"
        ).first
        return nil unless submission

        version = submission.app_store_version_for_review
        build = version&.get_build
        ReviewReplacement::Pending.new(
          state: submission.state, version: version&.version_string, build: build&.version,
          version_id: version&.id, handle: submission
        )
      end

      def cancel(pending)
        pending.handle.cancel_submission
      end

      # The version's state now, or nil for a submission without one.
      def version_state(pending)
        return nil unless pending.version_id

        version = @versions.call(pending.version_id)
        version && (version.app_version_state || version.app_store_state)
      end
    end
  end
end
