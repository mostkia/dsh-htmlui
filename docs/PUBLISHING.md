# Publishing @mostkia/dsh-htmlui

This is the release checklist for maintainers. It contains no account names,
machine paths, or tokens: fill those in from your own environment.

## 0. Preconditions

Walk [VERIFY.md](VERIFY.md) on a live host before tagging: it is the acceptance
checklist (which generation is running, what each placement looks like, how the
round trip shows up, and how to read a symptom). A release that has not been
looked at in a browser is not ready, however green the suites are.

```sh
npm run check     # syntax + all nine suites
npm pack --dry-run  # read the actual tarball contents before publishing
```

The package is dependency-free and needs no build step, so the tarball contains
the sources that ship: `index.js`, `client.js`, `assets/`, `templates/`,
`locale/`, `cordis.patch.yml`, `icon.svg`, `SKILL.md`, both READMEs,
`CHANGELOG.md`, and `LICENSE`.

Before tagging, confirm:

- `package.json` `version` matches `PLUGIN_VERSION` in `index.js`, the activation
  line in `client.js`, and the newest `CHANGELOG.md` heading. The suites assert
  the first two, so a mismatch fails CI.
- `README.md` and `README.zh.md` still describe the placements and the install
  command exactly as they behave.

## 1. GitHub repository

```sh
git remote add origin <your-repository-url>
git push -u origin main
```

The repository must declare `dsh.bundle` in `package.json` — the marketplace
gate rejects a package that only declares `dsh.client`. This repository does.

Tag the release:

```sh
git tag -a v$(node -p "require('./package.json').version") -m "release"
git push origin --tags
```

Optional: attach the packed tarball to the GitHub Release
(`npm pack` output). If you do, the asset name must not contain the version, so
`.../releases/latest/download/<name>.tgz` keeps working across releases.

## 2. npm (optional)

The marketplace entry does not require npm. Installing straight from GitHub
works, and the entry's `install` command is generated from the registry mapping
when a package exists. If you do publish:

```sh
npm publish --access public
```

Do not hand-write `npm:` in the marketplace entry: it is collected from the
registry, and the package's `repository` field must point back at this
repository (it does).

## 3. awesome-dsh-plugin

Submission is one pull request to `awesome-dsh-plugin/awesome-dsh-plugin` that
adds exactly one file:

- Path: `data/plugins/mostkia__dsh-htmlui.yml`
- Content: [`docs/awesome-dsh-plugin.yml`](awesome-dsh-plugin.yml) in this repository.
- Pull request body: [`docs/marketplace-pr.md`](marketplace-pr.md) in this
  repository, written so a reviewer does not have to reverse-engineer the plugin.

Rules that bite:

- `url` must match the repository exactly (it is compared as a string).
- `description.en` is required and **must end with a period**.
- A description containing `": "` must be quoted, or YAML reads it as a nested
  key. The prepared entry avoids the sequence entirely.
- Never hand-edit the generated READMEs in that repository, and never touch
  another contributor's entry.
- One pull request carries at most three entries.

The submission gate, in order:

1. the repository's `package.json` declares `dsh.bundle`;
2. the GitHub repository is at least **one day old** — this is the only check
   that clears by itself, and the gate re-runs it automatically, so a red mark
   here is not a reason to reopen or force-push anything;
3. awesome-lint and the site build.

Then a human reviews whether the code matches the description, whether the
category fits, whether it actually runs, and whether the installation does
anything unexpected. `docs/PUBLISHING.md` exists so anything unusual (the HTTP
carrier, the capability tokens, iframe placement) can be described in the pull
request body before a reviewer asks.

Screenshots are optional and belong in this repository, not in the entry: add a
`screenshots.json` next to `package.json` listing one to eight relative image
paths whenever a real capture is available.

## 4. After publishing

- Bump the version for every behaviour change; the marketplace shows the
  repository version, not the installed one.
- Keep `CHANGELOG.md` the single place that explains what changed.
- If a release is broken within the first hour and nobody has installed it,
  deleting and re-creating the tag is cleaner than shipping a patch release that
  only fixes the release.
