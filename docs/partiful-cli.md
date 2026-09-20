# Local Partiful CLI

Run from the `ripple` directory:

```sh
bash scripts/setup-partiful.sh
./.tools/partiful --version
./.tools/partiful doctor
```

The setup pins [partiful-cli v3.0.1](https://github.com/KalebCole/partiful-cli/releases/tag/v3.0.1), verifies its macOS ARM64 archive against the official release checksum, and installs `.tools/partiful`. The ignored `.tools/partiful-v3.0.1` directory retains the archive, checksums, and bundled README/LICENSE. No login happens during setup.

The account owner signs in once through a private interactive terminal:

```sh
./.tools/partiful auth login
```

Enter the phone number and SMS verification code at the CLI prompts. Do not put credentials or codes in command arguments, source files, or chat. The CLI manages its own local session; it does not require extracting browser credentials.

Read and inspect JSON output:

```sh
./.tools/partiful auth status
./.tools/partiful schema events.update
./.tools/partiful events list --when upcoming
./.tools/partiful events get EVENT_ID
./.tools/partiful guests list EVENT_ID
```

`auth status` can refresh the CLI's own session if credentials already exist. `doctor` checks local authentication state.

Preview a change with structured JSON on stdin:

```sh
./.tools/partiful events update EVENT_ID --input - --dry-run <<'JSON'
{
  "description": "Updated dinner details.",
  "start": "2026-12-11T18:00:00-05:00",
  "end": "2026-12-11T21:00:00-05:00",
  "timezone": "America/Detroit"
}
JSON
```

`--dry-run` validates and may read remote state but does not update the event. Removing it performs the update. Normal event edits, invitations, and text blasts can execute without a second CLI prompt, so Ripple should dispatch only its reviewed action. Verify event writes with `events get` or the Partiful page before marking a bridge job completed. A `submitted: true` response does not prove notification delivery.

The CLI supports date/time, title, description, capacity, links, and poster updates. **Updating an existing event's location is not supported**; use the browser bridge for that field. Guest invitations target one existing contact by name, and text blasts target all guests. This executable is an unofficial integration and has not yet been authenticated or verified against this user's account.
