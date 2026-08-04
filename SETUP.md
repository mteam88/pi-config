# Setup

The recommended installation keeps this repository in a separate checkout and
registers it as a local Pi package. Pi supports local package directories and
discovers their `extensions/`, `skills/`, and `themes/` resources.

## Recommended: separate checkout

Prerequisites:

- Node.js 22.19.0 or newer (required by the locked
  `@earendil-works/pi-*` 0.80.6 package manifests)
- a Pi installation compatible with `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` 0.80.6
- Git
- npm, for the committed lockfiles
- any external subagent CLIs you choose to enable

Clone the repository somewhere that is not `~/.pi/agent`:

```sh
git clone <repository-url> "$HOME/src/pi-config"
cd "$HOME/src/pi-config"
```

Install exactly the locked dependencies. Each extension with its own lockfile
has an isolated dependency set:

```sh
npm ci
for package_dir in extensions/*; do
  if [ -f "$package_dir/package-lock.json" ]; then
    npm --prefix "$package_dir" ci
  fi
done
```

Review the source before registering it. Then preserve a copy of the current
settings and install the checkout as a local package:

```sh
if [ -f "$HOME/.pi/agent/settings.json" ]; then
  cp -p "$HOME/.pi/agent/settings.json" \
    "$HOME/.pi/agent/settings.json.before-pi-config"
fi
pi install "$PWD"
pi list
```

`pi install` adds the local package reference to the existing user settings; it
does not copy the checkout over the agent directory. Keep the checkout at the
same path while the package is installed. Use `pi config` to review and
enable/disable individual resources. In Pi, open `/settings` to select
`github-dark-default` if desired.

The ask-user extension can optionally continue after an idle question instead
of waiting forever. Set `askUserQuestionTimeout` in your existing global
`~/.pi/agent/settings.json` to `"60s"`, `"5m"`, or `"10m"`. Use `"never"` or
omit the field to disable the timeout. A timeout never implies approval or
consent for an action that requires user authorization. This repository
deliberately does not ship or overwrite `settings.json`.

The task extension registers `TaskCreate`, `TaskGet`, `TaskList`, and
`TaskUpdate`, shows up to five tasks in the footer, and exposes the full panel
through `/todos` or Ctrl+Alt+T. Task state and metadata are stored in the Pi
session transcript, so do not put credentials or other secrets in them.

To remove the package later:

```sh
pi remove "$PWD"
```

## Optional verification

Run the same checks used for this public release:

```sh
npm run check
npm test
npm run format:check

for package_dir in extensions/*; do
  if [ -f "$package_dir/package.json" ]; then
    npm --prefix "$package_dir" run check --if-present
    npm --prefix "$package_dir" test --if-present
    npm --prefix "$package_dir" run format:check --if-present
  fi
done
```

Live subagent tests are intentionally separate because they launch configured
external CLIs and may consume credentials or quota:

```sh
npm run test:live
```

Run them only after reviewing the backend configuration and environment.

## Direct copy: fallback only

Direct copying is more invasive because resource names may collide with an
existing configuration. Do not replace the whole `~/.pi/agent` directory.
First make a private backup; it may contain credentials and must not be
published:

```sh
backup_dir="$HOME/.pi/agent-backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$HOME/.pi/agent" "$backup_dir"
```

From this repository, preview every resource change without writing:

```sh
rsync -avn --itemize-changes --exclude node_modules \
  extensions/ "$HOME/.pi/agent/extensions/"
rsync -avn --itemize-changes skills/ "$HOME/.pi/agent/skills/"
rsync -avn --itemize-changes themes/ "$HOME/.pi/agent/themes/"
```

If the dry run contains only intended changes, copy without deleting unrelated
files. Changed destination files are retained in the backup directory:

```sh
rsync -av --itemize-changes --exclude node_modules --backup \
  --backup-dir="$backup_dir/overwritten/extensions" \
  extensions/ "$HOME/.pi/agent/extensions/"
rsync -av --itemize-changes --backup \
  --backup-dir="$backup_dir/overwritten/skills" \
  skills/ "$HOME/.pi/agent/skills/"
rsync -av --itemize-changes --backup \
  --backup-dir="$backup_dir/overwritten/themes" \
  themes/ "$HOME/.pi/agent/themes/"
```

Install the nested locked dependencies in the copied extension directories:

```sh
for package_dir in extensions/*; do
  if [ -f "$package_dir/package-lock.json" ]; then
    target="$HOME/.pi/agent/$package_dir"
    npm --prefix "$target" ci
  fi
done
```

Do not copy this repository's root `package.json`, lockfile, or TypeScript
configuration over an existing agent directory. Do not overwrite
`settings.json`; select the theme through `/settings` instead.
