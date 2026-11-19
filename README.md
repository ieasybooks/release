# release

The release tooling ieasybooks apps share: their store listings, build numbers, AppGallery publishing, and the checks their release workflows run. Each app keeps its own workflows and fastlane lanes, which call this. [Mofied](https://github.com/ieasybooks/mofied) uses it, and its `docs/releasing.md` shows the whole setup.

- **`@ieasybooks/release`**, a Bun package with the `ieasybooks-release` command and `@ieasybooks/release/build-number`.
- **`ieasybooks-release`**, a Ruby gem with the App Store review helper for fastlane lanes (`ruby/`).

Neither has dependencies.

## Installing

Apps take both from this repository, pinned to a commit:

```jsonc
// package.json: the workspace whose app.config.ts imports the build numbers, and the root for the command
"devDependencies": { "@ieasybooks/release": "github:ieasybooks/release#<commit SHA>" }
```

```ruby
# Gemfile
gem "ieasybooks-release", git: "https://github.com/ieasybooks/release.git", ref: "<commit SHA>", glob: "ruby/*.gemspec"
```

bun.lock and Gemfile.lock record the commit, so an app gets new tooling only when it changes the pin, in a pull request its checks run on.

## Security

- **Pin a commit, never a branch or a tag.** This code runs in release jobs that hold signing keys and store credentials.
- **Run the command from `node_modules/.bin`,** or through a `package.json` script, and **never through `bunx` or `npx`**. Those would download whatever npm has under the name if the package were missing, and the name isn't ours on npm. A missing package should fail the job.
- Install with lifecycle scripts off where the job needs only the command (`bun install --ignore-scripts`): this package has none.

## Commands

`ieasybooks-release <command>`; `--app` names the app's folder, such as `apps/mobile`, which holds its `package.json` and `store/`.

| Command                                               | What it does                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-info --app <folder>`                         | Prints the version and build numbers as JSON for fastlane: `{"version":"0.1.3","iosBuildNumber":"1003","androidVersionCode":1003}`. The version is `package.json`'s, or a Flutter app's `pubspec.yaml`'s: its `package.json` only installs this tooling. |
| `store check --app <folder> [--tag <tag>]`            | Checks that the version can be released: that it makes valid build numbers, that it matches the tag if given (`v<version>`), and that `store/` has everything every store needs within its limits, with the version's release notes in every language.   |
| `store fastlane-metadata --app <folder> <out>`        | Replaces `<out>` with `store/` in the layouts fastlane reads: `app-store/{metadata,screenshots}` for deliver and `google-play/metadata` for supply.                                                                                                      |
| `appgallery publish --app <folder> <apk> [--dry-run]` | Publishes the APK to AppGallery with the service account key in `APPGALLERY_CONNECT_SERVICE_ACCOUNT`; see [AppGallery](#appgallery).                                                                                                                     |
| `routing <base> <head>`                               | Checks that each commit between the refs, and the pull request title in `TITLE`, that would release changes a component of `release-please-config.json`.                                                                                                 |
| `verify-commit <tag> <sha> [--checked]`               | Checks that the tag points at the commit, through annotated tags, and with `--checked` that the commit's latest `Checks` status passed. Uses `gh`, `GH_TOKEN` and `GITHUB_REPOSITORY`.                                                                   |
| `not-superseded <tag>`                                | Stops a release when a newer version tag of its component exists (`v*` for the apps, `web-v*` for the web), so a re-run of an older release can't replace a newer one. Uses `gh`, `GH_TOKEN` and `GITHUB_REPOSITORY`.                                    |

`@ieasybooks/release/build-number` exports `buildNumber(version)`, plain CommonJS with types, which `app.config.ts` imports: Expo loads that with Node's `require`.

## Conventions

- **Build numbers** follow from the version: 1.2.3 builds as 1002003 on iOS and Android, so a release never needs one raised by hand. Minor and patch go up to 999. A Flutter app's `pubspec.yaml` holds a plain version, without `+build`: its builds take `--build-number` from `release-info`.
- **Tags**: the apps release from `v<version>` tags, the web from `web-v<version>`. Other `v*` tags are dry runs.
- **Commit titles** follow Conventional Commits, which release-please reads: `fix:` and `feat:` release the components a commit changes, and `chore:`, `docs:`, `ci:`, `build:`, `test:`, `refactor:`, `style:`, and any other type, such as Shawared's `content:`, release nothing. `routing` holds pull requests to that.

## The store folder

Everything the stores show besides the app itself, in `<app>/store/`. Each release sends it to the App Store, Google Play and AppGallery, overwriting edits made in their consoles.

`store.json`:

```json
{
  "name": "Mofied",
  "languages": {
    "ar": { "appStore": "ar-SA", "googlePlay": "ar", "appGallery": "ar" },
    "en": { "appStore": "en-US", "googlePlay": "en-US", "appGallery": "en-US" }
  },
  "appStore": {
    "supportUrl": "…",
    "marketingUrl": "…",
    "privacyUrl": "…",
    "copyrightHolder": "الكتب المُيسّرة"
  },
  "appGallery": { "appId": "…" }
}
```

`name` is the app's name in messages. `languages` lists one folder per language with each store's locale code for it. Each App Store release gets the copyright line "`<year> <copyrightHolder>`", with the year of the release.

`stores` lists the stores an app is released to, when it isn't all three: `["googlePlay", "appGallery"]` for an Android-only app. The folder then needs only what those stores use: no `appStore` settings, App Store locales, App Store texts (`app-store-name.txt`, `subtitle.txt`, `keywords.txt`), App Store reviewer notes or App Store screenshots, and `store fastlane-metadata` writes only `google-play/`.

### Texts

| File (per language)                  | App Store        | Google Play       | AppGallery         | Limit  |
| ------------------------------------ | ---------------- | ----------------- | ------------------ | ------ |
| `<lang>/name.txt`                    |                  | Title             | App name           | 30     |
| `<lang>/app-store-name.txt`          | Name             |                   |                    | 30     |
| `<lang>/subtitle.txt`                | Subtitle         |                   |                    | 30     |
| `<lang>/short-description.txt`       | Promotional text | Short description | Brief introduction | 80     |
| `<lang>/description.txt`             | Description      | Full description  | Introduction       | 4000   |
| `<lang>/keywords.txt`                | Keywords         |                   |                    | 100    |
| `release-notes/<version>/<lang>.txt` | What's New       | Release notes     | New features       | 500    |
| `review-notes/app-store.txt`         | App Review notes |                   |                    | 4000   |
| `review-notes/appgallery.txt`        |                  |                   | Remarks            | 10–300 |

Limits are in characters, as people count them. App Store names are unique across the store, which is why the App Store name has its own file.

### Images

Under `screenshots/<store>/<lang>/`, shown in file name order:

| Folder                                      | Contents                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `app-store/<lang>/iphone`                   | 1 to 10 iPhone screenshots (1320x2868, 1290x2796, 1206x2622, 1284x2778 or 1242x2688) |
| `app-store/<lang>/ipad`                     | Up to 10 iPad screenshots (2064x2752 or 2048x2732, either way round)                 |
| `google-play/<lang>/icon.png`               | The 512x512 store icon                                                               |
| `google-play/<lang>/feature-graphic.png`    | The 1024x500 feature graphic                                                         |
| `google-play/<lang>/phone`                  | 2 to 8 phone screenshots, 320 to 3840 pixels a side, at most 2:1                     |
| `google-play/<lang>/seven-inch`, `ten-inch` | Up to 8 tablet screenshots each                                                      |
| `appgallery/<lang>/icon.png`                | The 216x216 store icon                                                               |
| `appgallery/<lang>/phone`                   | 3 to 5 phone screenshots                                                             |

Google Play and AppGallery receive only images that changed. The App Store's screenshots are replaced on each release.

## AppGallery

`appgallery publish` uses the AppGallery Connect Publishing API with a service account, which fastlane doesn't support. A release uploads the APK, updates each language's texts and, when they changed, its icon and screenshots, then submits the version with the reviewer notes; AppGallery releases it once approved. A version still in review can't change, and the API can't cancel a review, so a release stops before changing anything while one is in review: cancel it in AppGallery Connect, then re-run.

A dry run (`--dry-run`) changes nothing. It proves the credentials work, the app is reachable, and AppGallery issues an upload URL for the APK, and it reports what a release would change. Huawei never sees the APK or the texts, so an app's first real upload is still the integration check.

## The App Store review helper

`Ieasybooks::Release::ReviewReplacement` clears the way for a new App Store submission, run by an app's submit lane once the new build has processed. App Store Connect keeps one review submission in progress per platform:

- **Nothing in review:** there's nothing to do.
- **A newer version or build in review:** it stops without cancelling it. An older release's job re-run after a newer release would otherwise replace it.
- **This version and build in review:** there's nothing to submit. If App Store review returned it with unresolved issues, it stops, since only a new version fixes that.
- **Anything else in review:** it cancels it, then waits until App Store Connect has finished, for up to 15 minutes before giving up without submitting. Finished means the submission is no longer cancelling and its version no longer in review.
- **A submission already cancelling:** it only waits for it.

`Ieasybooks::Release::AppStoreReviews` reads App Store Connect through fastlane's spaceship. Unlike fastlane's own `get_in_progress_review_submission`, it also sees submissions that are still `CANCELING`. Only this helper should cancel reviews, so keep deliver's `reject_if_possible` off.

## Development

```sh
mise install
mise exec -- bun install
mise exec -- bun run check      # typecheck, tests, Prettier
mise exec -- bun run test:ruby  # the gem's tests
```

The tests use a made-up app with a complete store folder in Arabic and English (`test/fixture.ts`), whose languages differ on purpose. The Test workflow runs the checks, then installs the package and the gem from GitHub at the tested commit into an empty project and runs every command from `node_modules/.bin`.

## Releases

Merge to `main`, tag the commit `vX.Y.Z`, and raise `version` in `package.json` and `ruby/ieasybooks-release.gemspec` with it. Apps pin the commit, not the tag; the tag names it in their pull requests.
