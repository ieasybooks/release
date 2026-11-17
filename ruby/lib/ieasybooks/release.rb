# The Ruby half of ieasybooks/release, for apps' fastlane lanes:
#
#   require "ieasybooks/release"
#   Ieasybooks::Release::ReviewReplacement.new(store: Ieasybooks::Release::AppStoreReviews.new(app, platform), ...)
#
# See ../../README.md.
require_relative "release/review_replacement"
