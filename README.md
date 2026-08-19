# Shared edit logs

This branch is written by the Cloudflare Worker in `tools/sync-worker/worker.js`
on `main`. It holds one append-only log per synced data file:

    data/sync/packing.log.json

Nothing here is published. GitHub Pages serves `main`, and the logs live on their
own branch so that saving an edit does not trigger a site rebuild - Pages
throttles those at around ten an hour, which a group ticking through a packing
list would reach.

Do not edit these files by hand. To fold a log back into the committed data file,
run `tools/squash_sync.py` from a checkout of `main`.

`docs/sync-setup.md` on `main` explains the whole design.
