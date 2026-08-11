# Working in a repo with other agents in it

Several Claude sessions, and a human, edit this repo at the same time. Nothing
coordinates them. The working tree is shared mutable state, and `git` commands
that operate on "everything" are the sharp edge.

This document is the long form of rule zero in [CLAUDE.md](../../CLAUDE.md).

## What went wrong, concretely

Commit [`23c5f04`](https://github.com/lnorton89/classg/commit/23c5f04) is titled
*"Add the always-on recording switch (API side)"*. It contains that, and also a
complete rewrite of the satellite basemap across five UI files — a different
feature, by a different session, that happened to be uncommitted at that moment.

Nobody did anything malicious. One session ran a catch-all add, git faithfully
staged every dirty file in the tree, and the commit message described only what
its author knew about. By the time it was noticed it had been pushed to `main`,
where splitting it would need a force-push to a branch other sessions were
building on. It is now permanent.

The cost is not tidiness. It is that `git log` no longer answers "why did the
basemap change?", `git revert` on the recording switch would silently revert the
basemap too, and `git bisect` blames one feature for the other's bugs.

## The rules

### Never run whole-tree commands

```
git add -A        git add .          git commit -a       git commit -am
git stash         git reset --hard   git checkout -- .   git clean -fd
```

The first four **capture** others' work into your commit. The last four
**destroy** it — `git stash` is the quiet one, because it looks reversible and
isn't when someone else's editor is holding the file.

These are denied in [`.claude/settings.json`](../../.claude/settings.json),
along with `git rebase`, `git push --force`, and `git filter-branch`. Rules
match on command prefix, which covers the forms people actually type but not
every variant — `git commit -m "msg" -a` puts the flag past the matched prefix,
and a command wrapped in a subshell or `git -C` may not be decomposed the way
you expect. Treat a block as confirmation you were about to do the wrong thing,
never as a puzzle to route around.

### Commit with an explicit pathspec

```bash
git commit --only services/ui/src/features/map/style.ts services/ui/nginx.conf \
  -m "Raise the basemap zoom ceiling"
```

`--only` stages and commits exactly those paths and nothing else, even if other
files are dirty or already staged. If you prefer two steps, `git add <paths>`
then `git commit <same paths>` — never a bare `git commit` after staging, since
that picks up anything already in the index from another session.

### Track what you touched

Keep a mental list of every file you edited this session. That list is the
*only* thing allowed in your commit. If a file is dirty and not on your list,
it is not yours, no matter how obviously it "belongs" with your change.

### Read `git status` as a signal, not a checklist

```bash
git status --short
```

Files you did not touch mean another session is live right now. That is not a
mess to clean up. Leave them, don't stage them, don't mention them in your
message, and don't "helpfully" fix a lint error you spot in them — you will
collide with an editor mid-write.

### History rewriting

`git commit --amend` is safe only when all three hold:

1. You made the commit.
2. You made it this session.
3. It has not been pushed.

Check the third before you rely on it:

```bash
git rev-list --left-right --count origin/main...HEAD
```

`0  0` means local and remote match — the commit is **already pushed**, so
amending it rewrites published history. Don't. Write a follow-up commit instead.

Never `git rebase`, `git push --force`, or `git push --force-with-lease` on a
shared branch without the user explicitly asking for it in that session.

### Commit only when asked

Finishing a change is not a request to commit it. Leave the work in the tree and
say what you changed. The user decides when it lands — and if two sessions are
running, only they can see whether now is a sensible moment.

## Recovering when it happens anyway

**Not yet committed, wrong things staged:**

```bash
git restore --staged <paths-that-arent-yours>
```

Unstages without touching file contents. Safe with others editing.

**Committed but not pushed** — verify with the `rev-list` check above, then:

```bash
git reset --soft HEAD~1
```

Moves the commit's changes back to the index, keeping every file exactly as it
is on disk. Then re-commit with an explicit pathspec. Never `--hard`.

**Already pushed:** stop and tell the user. Do not force-push. The honest
options are to leave it and write a follow-up commit that explains what actually
changed, or to have the user coordinate a history rewrite with everyone working
in the repo. Splitting a pushed commit is their call, not yours.

## Verify before you claim

The other half of not stepping on people: don't report work as done on evidence
you didn't actually gather. Run the real checks, and know which ones lie.

See [CLAUDE.md](../../CLAUDE.md#verifying-your-work) for the per-service
commands and the no-op traps — including `npm run typecheck`, which for a long
time typechecked exactly zero files while reporting success.
