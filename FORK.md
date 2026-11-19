# T3 Code, with a few small fixes

This is T3 Code with a handful of changes I made while using it every day. Everything else is the
official app. Each official release gets the same changes put back on top, usually the same day.

## What's different

- **Pinned projects row.** Your pinned projects sit as small icons under the search box. One click
  switches project. Right-click for options, drag to reorder, drag one in to pin it, drag it out to
  unpin. The first time, your 5 most recent projects are pinned for you.
- **Usage on the model picker.** Rest the mouse on the model picker for a moment and it shows that
  account's plan limits and when they reset. Moving past it shows nothing.
- **Older messages load as you scroll up.** No need to press "Load earlier turns".
- **Imported Claude chats keep their history.** An imported Claude chat shows its old messages and
  pictures when you open it, and a message sent into it waits until they're loaded.

## Install (Mac, Apple Silicon)

You need git, Node, and the build tool T3 uses: `npm install -g vite-plus@1.4.0`.

```bash
git clone https://github.com/itslazerw/t3code.git ~/t3-fork
~/t3-fork/scripts/fork-update/t3-fork-update check --force
```

That downloads the official release, checks Apple's signature, adds the changes, builds, and tests
it on a copy of your data. If T3 is closed it goes in right away; if T3 is open it waits for the next
check after you close it. To swap it in now, run
`~/t3-fork/scripts/fork-update/t3-fork-update restart` (it quits and reopens T3, and won't while a
chat is working).

## Updates

Run `check` every hour with the example in `scripts/fork-update/com.t3fork.update.plist`. When T3
releases a new version, the script builds it with these changes. If one of them no longer fits the
new version, it's left out and you get a Mac notification saying which. If the build fails, you get
the plain official release, so you never fall behind.

Your T3 data (the `~/.t3/userdata` folder) is backed up before every swap; the newest 2 are kept.

## Going back

`t3-fork-update stock` puts the plain official T3 back. Remove the hourly check to stop updates.

Mac only for now. The web screens work from any browser connected to a Mac running this build.
