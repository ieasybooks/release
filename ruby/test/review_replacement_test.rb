# bun run test:ruby
require "minitest/autorun"
require "ieasybooks/release"

class ReviewReplacementTest < Minitest::Test
  Pending = Ieasybooks::Release::ReviewReplacement::Pending

  # App Store Connect's review submissions and versions, as scripts: each call
  # to #pending or #version_state answers with its next entry, repeating the
  # last one.
  class FakeStore
    attr_reader :cancelled, :calls

    def initialize(*answers, version_states: ["DEVELOPER_REJECTED"])
      @answers = answers
      @version_states = version_states
      @cancelled = []
      @calls = []
    end

    def pending
      @calls << :pending
      @answers.length > 1 ? @answers.shift : @answers.first
    end

    def cancel(pending)
      @calls << :cancel
      @cancelled << pending
    end

    def version_state(pending)
      @calls << [:version_state, pending.version_id]
      @version_states.length > 1 ? @version_states.shift : @version_states.first
    end
  end

  def replacement(store, now: [0], **options)
    @logged = []
    @slept = []
    Ieasybooks::Release::ReviewReplacement.new(
      store: store, version: "0.1.4", build: "1004", timeout: 600, interval: 15,
      clock: -> { now.first }, sleeper: ->(seconds) { @slept << seconds; now[0] += seconds },
      log: ->(message) { @logged << message }, **options
    )
  end

  def older(state = "WAITING_FOR_REVIEW")
    Pending.new(state: state, version: "0.1.3", build: "1003", version_id: "v013", handle: :older_submission)
  end

  def newer(state = "WAITING_FOR_REVIEW", version: "0.1.5", build: "1005")
    Pending.new(state: state, version: version, build: build, version_id: "v015", handle: :newer_submission)
  end

  def ours(state)
    Pending.new(state: state, version: "0.1.4", build: "1004", version_id: "v014", handle: :ours)
  end

  def test_nothing_in_review
    store = FakeStore.new(nil)
    assert_equal :nothing_in_review, replacement(store).run
    assert_equal [], store.cancelled
    assert_equal ["Nothing is in review on the App Store."], @logged
  end

  def test_cancels_an_older_submission_then_waits_until_it_is_gone
    store = FakeStore.new(older, older("CANCELING"), older("CANCELING"), nil)
    assert_equal :cancelled, replacement(store).run
    assert_equal [:older_submission], store.cancelled.map(&:handle)
    # Read, cancel, poll until App Store Connect has no submission in progress
    # or cancelling, then check the version left review.
    assert_equal [:pending, :cancel, :pending, :pending, :pending, [:version_state, "v013"]], store.calls
    assert_equal [15, 15], @slept
    assert_equal "Pulling 0.1.3 (1003, WAITING_FOR_REVIEW) out of review so 0.1.4 (1004) replaces it.", @logged.first
    assert_equal "Waiting for App Store Connect to cancel the review (0.1.3 (1003, CANCELING) is still in progress)...", @logged[1]
    assert_equal "The review is cancelled; 0.1.4 (1004) goes next.", @logged.last
  end

  def test_waits_for_the_version_to_leave_review_after_the_submission
    store = FakeStore.new(older, nil, version_states: %w[WAITING_FOR_REVIEW IN_REVIEW DEVELOPER_REJECTED])
    assert_equal :cancelled, replacement(store).run
    assert_equal [15, 15], @slept
    assert_equal "Waiting for App Store Connect to cancel the review (0.1.3 is still WAITING_FOR_REVIEW)...", @logged[1]
    assert_equal "Waiting for App Store Connect to cancel the review (0.1.3 is still IN_REVIEW)...", @logged[2]
  end

  def test_any_state_out_of_review_lets_it_go_on
    [nil, "DEVELOPER_REJECTED", "PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"].each do |state|
      store = FakeStore.new(older, nil, version_states: [state])
      assert_equal :cancelled, replacement(store).run, state.inspect
      assert_equal [], @slept, state.inspect
    end
  end

  def test_cancels_a_version_in_review_too
    store = FakeStore.new(older("IN_REVIEW"), nil)
    assert_equal :cancelled, replacement(store).run
    assert_equal 1, store.cancelled.length
  end

  def test_a_submission_already_cancelling_is_only_waited_for
    store = FakeStore.new(older("CANCELING"), older("CANCELING"), nil)
    assert_equal :cancelled, replacement(store).run
    assert_equal [], store.cancelled
    assert_equal [15], @slept
    assert_equal "0.1.3 (1003, CANCELING) is already being pulled out of review; waiting for it so 0.1.4 (1004) replaces it.", @logged.first
  end

  # Someone pulled this release's own submission out of review: once that has
  # finished, it's submitted again.
  def test_this_version_and_build_cancelling_is_waited_for_then_submitted
    store = FakeStore.new(ours("CANCELING"), nil)
    assert_equal :cancelled, replacement(store).run
    assert_equal [], store.cancelled
  end

  def test_a_timeout_stops_before_submitting
    store = FakeStore.new(older, older("CANCELING"))
    error = assert_raises(Ieasybooks::Release::ReviewReplacement::Error) { replacement(store).run }
    assert_equal "App Store Connect hasn't finished cancelling 0.1.3 (1003, WAITING_FOR_REVIEW) 10 minutes after the cancellation " \
                 "(0.1.3 (1003, CANCELING) is still in progress); submitted nothing.", error.message
    assert_equal 600, @slept.sum
  end

  def test_a_timeout_while_the_version_is_still_in_review_stops_too
    store = FakeStore.new(older, nil, version_states: ["WAITING_FOR_REVIEW"])
    error = assert_raises(Ieasybooks::Release::ReviewReplacement::Error) { replacement(store).run }
    assert_match(/\(0\.1\.3 is still WAITING_FOR_REVIEW\); submitted nothing\.\z/, error.message)
    assert_equal 600, @slept.sum
  end

  def test_this_version_and_build_already_in_review_is_left_alone
    %w[WAITING_FOR_REVIEW IN_REVIEW].each do |state|
      store = FakeStore.new(ours(state))
      assert_equal :already_submitted, replacement(store).run
      assert_equal [], store.cancelled
      assert_equal ["0.1.4 (1004, #{state}) is already submitted, so there's nothing to submit."], @logged
    end
  end

  def test_this_version_returned_with_issues_needs_a_new_version
    store = FakeStore.new(ours("UNRESOLVED_ISSUES"))
    error = assert_raises(Ieasybooks::Release::ReviewReplacement::Error) { replacement(store).run }
    assert_match(/returned 0\.1\.4 \(1004, UNRESOLVED_ISSUES\)\. Fix the issues and release a new version\./, error.message)
    assert_equal [], store.cancelled
  end

  def test_the_same_version_with_an_older_build_is_replaced
    store = FakeStore.new(Pending.new(state: "WAITING_FOR_REVIEW", version: "0.1.4", build: "999", version_id: "v014", handle: :stale), nil)
    assert_equal :cancelled, replacement(store).run
    assert_equal [:stale], store.cancelled.map(&:handle)
  end

  # An older release's App Store job re-run after a newer release was
  # submitted: it must not pull the newer one out of review, in any state, and
  # a dry run says so too.
  def test_a_newer_version_or_build_is_never_cancelled
    [
      newer,
      newer("IN_REVIEW"),
      newer("UNRESOLVED_ISSUES"),
      newer("CANCELING"),
      newer(version: "0.2.0", build: "2000"),
      newer(version: "1.0.0", build: nil),
      newer(version: "0.1.10", build: "1010"),
      newer(version: "0.1.4", build: "1005")
    ].each do |pending|
      [false, true].each do |dry_run|
        store = FakeStore.new(pending, nil)
        error = assert_raises(Ieasybooks::Release::ReviewReplacement::Error) { replacement(store).run(dry_run: dry_run) }
        assert_equal "#{pending.version} (#{pending.build || 'no build'}, #{pending.state}) is newer than 0.1.4 (1004), which would " \
                     "replace it; cancelled nothing. Release #{pending.version} or a later version instead.", error.message
        assert_equal [:pending], store.calls, "#{pending.to_h} dry_run: #{dry_run}"
      end
    end
  end

  def test_compares_versions_as_numbers_not_text
    store = FakeStore.new(Pending.new(state: "WAITING_FOR_REVIEW", version: "0.1.10", build: "1010", handle: :older), nil)
    replacement = Ieasybooks::Release::ReviewReplacement.new(store: store, version: "0.1.11", build: "1011", log: ->(_) {})
    assert_equal :cancelled, replacement.run
  end

  def test_a_version_it_cannot_compare_cancels_nothing
    store = FakeStore.new(newer(version: "next"), nil)
    error = assert_raises(Ieasybooks::Release::ReviewReplacement::Error) { replacement(store).run }
    assert_equal "Can't tell whether App Store Connect's \"next\" is newer than 0.1.4 (1004); cancelled nothing.", error.message
    assert_equal [], store.cancelled
  end

  def test_a_dry_run_only_says_what_it_would_do
    store = FakeStore.new(older)
    assert_equal :would_cancel, replacement(store).run(dry_run: true)
    assert_equal [], store.cancelled
    assert_equal [:pending], store.calls
    assert_equal ["Would pull 0.1.3 (1003, WAITING_FOR_REVIEW) out of review so 0.1.4 (1004) replaces it."], @logged
  end

  def test_a_dry_run_with_a_submission_cancelling
    store = FakeStore.new(older("CANCELING"))
    assert_equal :would_cancel, replacement(store).run(dry_run: true)
    assert_equal [:pending], store.calls
    assert_equal ["Would wait for App Store Connect to finish pulling 0.1.3 (1003, CANCELING) out of review, then submit 0.1.4 (1004)."], @logged
  end

  def test_a_submission_without_a_version_or_build_is_described
    store = FakeStore.new(Pending.new(state: "UNRESOLVED_ISSUES", version: nil, build: nil, handle: :odd))
    assert_equal :would_cancel, replacement(store).run(dry_run: true)
    assert_equal ["Would pull a version (no build, UNRESOLVED_ISSUES) out of review so 0.1.4 (1004) replaces it."], @logged
  end
end

class AppStoreReviewsTest < Minitest::Test
  Version = Struct.new(:id, :version_string, :build) do
    def get_build
      build
    end
  end
  Build = Struct.new(:version)
  Submission = Struct.new(:state, :app_store_version_for_review, :cancelled) do
    def cancel_submission
      self.cancelled = true
    end
  end
  VersionState = Struct.new(:app_version_state, :app_store_state)

  # App Store Connect's GET /v1/apps/{id}/reviewSubmissions, as spaceship's
  # App#get_review_submissions calls it: it answers with the submissions in
  # the states filter[state] lists, on the platform filter[platform] names.
  class FakeApp
    attr_reader :asked

    def initialize(*submissions)
      @submissions = submissions
    end

    def get_review_submissions(filter:, includes:)
      @asked = { filter: filter, includes: includes }
      states = filter.fetch(:state).split(",")
      filter.fetch(:platform) == "IOS" ? @submissions.select { |s| states.include?(s.state) } : []
    end
  end

  def test_reads_the_version_and_build_in_review_and_cancels_that_submission
    submission = Submission.new("IN_REVIEW", Version.new("v013", "0.1.3", Build.new("1003")))
    app = FakeApp.new(submission)
    reviews = Ieasybooks::Release::AppStoreReviews.new(app, "IOS", versions: ->(_) { flunk })
    pending = reviews.pending
    assert_equal(
      { filter: { state: "WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING", platform: "IOS" }, includes: "appStoreVersionForReview" },
      app.asked
    )
    assert_equal ["IN_REVIEW", "0.1.3", "1003", "v013"], [pending.state, pending.version, pending.build, pending.version_id]
    reviews.cancel(pending)
    assert submission.cancelled
  end

  # fastlane's get_in_progress_review_submission would answer nil here, and
  # the lane would submit while App Store Connect is still cancelling.
  def test_finds_a_submission_still_being_cancelled
    app = FakeApp.new(Submission.new("CANCELING", Version.new("v013", "0.1.3", Build.new("1003"))))
    pending = Ieasybooks::Release::AppStoreReviews.new(app, "IOS").pending
    assert_equal ["CANCELING", "0.1.3"], [pending.state, pending.version]
  end

  def test_ignores_submissions_that_are_done_or_not_yet_submitted
    app = FakeApp.new(Submission.new("COMPLETE", nil), Submission.new("READY_FOR_REVIEW", nil), Submission.new("COMPLETING", nil))
    assert_nil Ieasybooks::Release::AppStoreReviews.new(app, "IOS").pending
  end

  def test_nothing_in_review
    assert_nil Ieasybooks::Release::AppStoreReviews.new(FakeApp.new, "IOS").pending
  end

  def test_a_submission_without_a_version
    pending = Ieasybooks::Release::AppStoreReviews.new(FakeApp.new(Submission.new("UNRESOLVED_ISSUES", nil)), "IOS").pending
    assert_equal ["UNRESOLVED_ISSUES", nil, nil, nil], [pending.state, pending.version, pending.build, pending.version_id]
  end

  def test_reads_the_version_state_by_its_id
    asked = []
    versions = lambda do |id|
      asked << id
      VersionState.new("DEVELOPER_REJECTED", "DEVELOPER_REJECTED")
    end
    reviews = Ieasybooks::Release::AppStoreReviews.new(FakeApp.new, "IOS", versions: versions)
    assert_equal "DEVELOPER_REJECTED", reviews.version_state(Ieasybooks::Release::ReviewReplacement::Pending.new(version_id: "v013"))
    assert_equal ["v013"], asked
  end

  def test_the_version_state_falls_back_to_the_older_field
    reviews = Ieasybooks::Release::AppStoreReviews.new(FakeApp.new, "IOS", versions: ->(_) { VersionState.new(nil, "WAITING_FOR_REVIEW") })
    assert_equal "WAITING_FOR_REVIEW", reviews.version_state(Ieasybooks::Release::ReviewReplacement::Pending.new(version_id: "v013"))
  end

  def test_no_version_state_without_a_version
    reviews = Ieasybooks::Release::AppStoreReviews.new(FakeApp.new, "IOS", versions: ->(_) { flunk })
    assert_nil reviews.version_state(Ieasybooks::Release::ReviewReplacement::Pending.new(version_id: nil))
  end
end
