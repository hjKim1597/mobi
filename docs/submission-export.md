# History-free submission export

Prepare the submission in a new directory or repository from the finished worktree. Copy only the explicit allowlist below; do not clone, bundle, or copy Git metadata. This procedure is a checklist and does not perform the export.

## Include

- Root `README.md` with introduction, run instructions, test environment, and the submitted APK path.
- `apk/<team>_<app>_release.apk`, built from the final reviewed source and signed with the neutral submission key.
- `app/` source, Gradle wrapper, and required project configuration. Do not include local signing files or local SDK paths.
- `server/` source, package manifests/lockfile, and required non-secret configuration templates.
- Only approved public documents from `docs/`, including this checklist. Confirm each document is intended for public release.

Use this allowlist when assembling the export:

```text
README.md
apk/<team>_<app>_release.apk
app/**
server/**
docs/api.md
docs/proposal.md
docs/submission-export.md
```

Review each included path against the exclusions below before copying. The allowlist does not authorize copying ignored or local-only files nested under `app/` or `server/`.

## Exclude

- `.git/`, all Git history, tags, remotes, reflogs, bundles, and repository metadata.
- `.context/`, `.omc/`, `spike/`, audit notes, private fixtures, and unapproved planning/evidence files.
- Build outputs and caches: `**/build/`, `.gradle/`, `node_modules/`, `.wrangler/`, npm caches, temporary files, and generated debug artifacts.
- Private configuration and credentials: `.dev.vars`, `local.properties`, signing properties, keystores/certificates, passwords, OAuth client secrets, tokens, and account-specific local files.
- Unsigned/debug APKs, unapproved audio/video, screenshots containing personal or account data, and files outside the explicit allowlist.

## Before export

- Confirm the chosen team/app APK filename and that the APK is the final signed release build. Verify its package, version, and certificate with the Android SDK `apksigner`; inspect certificate subject/issuer for real names, email addresses, organization, or other identifying details. Confirm the certificate is the approved neutral submission certificate.
- Check the current export author/committer as `mobi` (`git log -1 --format='%an <%ae> | %cn <%ce>'` in the source worktree). Do not transfer that worktree's `.git` directory or history into the submission.
- Confirm `CLOUDFLARE_ACCOUNT_ID` is supplied only through the local environment when the asset-generation tool is intentionally used. Never add the value to tracked files or export-local configuration.
- Check source, README, approved docs, APK metadata, filenames, and included assets for real names, personal emails/contacts, affiliations, machine paths, credentials, and private account identifiers. Confirm the server address and OAuth consent screen use the approved neutral submission branding.
- Review the final GitHub repository owner, profile/avatar, README, links, releases, and attached files for personal name/email/affiliation exposure. Review OAuth consent-screen app name, support/developer contacts, homepage, and privacy links in the actual provider settings.
- Review the video plan and final video, including channel/profile identity, visible IDE/terminal paths, status bar, account/calendar screens, QR codes, notifications, logs, captions, filenames, and media metadata. Use synthetic demo data only.

## After assembly

- Inspect the exported file list against the allowlist and exclusions. Confirm `.git` and all history artifacts are absent, then scan the assembled export for secrets and identity markers.
- Recheck the APK signature, certificate subject, package/version, and exact filename in the exported directory.
- Confirm included source and approved docs are sufficient to build and run the app/server without local secrets. Record any intentionally external setup as instructions, not copied credentials.
- Do not publish the export until GitHub, OAuth, APK, and video checks above have evidence and all placeholders have been resolved.
