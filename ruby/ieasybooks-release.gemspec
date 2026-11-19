# Apps take the gem from git, pinned to a commit in their Gemfile.lock:
#
#   gem "ieasybooks-release", git: "https://github.com/ieasybooks/release.git",
#                             ref: "<commit SHA>", glob: "ruby/*.gemspec"
#
# It has no dependencies; AppStoreReviews uses fastlane's spaceship, which the
# app's fastlane brings.
Gem::Specification.new do |spec|
  spec.name = "ieasybooks-release"
  spec.version = "2.0.0"
  spec.summary = "The fastlane helpers ieasybooks apps share."
  spec.authors = ["ieasybooks"]
  spec.license = "MIT"
  spec.homepage = "https://github.com/ieasybooks/release"
  spec.required_ruby_version = ">= 3.3"
  spec.files = Dir.chdir(__dir__) { Dir["lib/**/*.rb"] }
  spec.require_paths = ["lib"]
end
