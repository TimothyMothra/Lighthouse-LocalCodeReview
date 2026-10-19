# Demo screenshots

The canonical README screenshot lives at **`docs/images/screenshot.png`** (referenced by the
top-level `README.md`). Generate its dataset with the one-command demo script:

```powershell
npm run compile
pwsh -File scripts\demo-setup.ps1          # create a throwaway, PII-free demo repo in %TEMP%
```

Open the generated folder in an isolated VS Code profile with only Lighthouse enabled. Compare
`feature/demo → main`, expand Comparison, and frame the three panes
(Comparison / Changed Files / Threads) with the `src/api/handlers.ts` `[bug]` thread visible.
Commits stays embedded in Comparison; leave it collapsed for a compact capture.
Save the capture to `docs/images/screenshot.png`. Keep real workspaces, recent-project lists,
accounts, terminals, and notifications out of the image.

See [`DEMO.md`](../../DEMO.md) for the isolated-profile launch command in **Screenshot dataset**
(`scripts\demo-setup.ps1`), plus Option A (F5 dev host), Option B (sideload the `.vsix`), and
Option C (VM sideload via hyperloop).
