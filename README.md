# IMMICH CLI

**Note:** This is a forked version of the official Immich CLI providing an extra command for deleting assets. [Original Github Repo](https://github.com/immich-app/CLI) --> [Forked Github Repo](https://github.com/Souptik2001/immich-cli).

For deleting all images of an album:

```bash
immich delete --key <key> --server https://example.com/api --album <album_id>
```

For deleting all images within a given timeframe:

```bash
immich delete --key <key> --server https://example.com/api --date_lower_limit "2 July 2023" --date_upper_limit "10 July 2023"
```

CLI utilities to help with some operations with the Immich app

You can find instructions for using the CLI [in the official Immich documentation](https://immich.app/docs/features/bulk-upload).
