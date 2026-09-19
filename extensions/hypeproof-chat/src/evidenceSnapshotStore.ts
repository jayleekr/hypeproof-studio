// Remote classroom operations (#751) — the ONLY place that removes a frozen snapshot copy.
//
// Scope, on purpose:
//   - It deletes the App's own copy under its private storage (`classroom-snapshots/<batch>`),
//     made for an upload the learner has now withdrawn consent for. Keeping it "just in
//     case" would be keeping what they asked us not to send.
//   - It never touches the workspace, the live spool, the conversation or any learner file.
//   - It is reachable from the learner's own consent command only — never from a remote
//     command. The remote-command modules stay free of any delete call
//     (test/runtime-reset.smoke.mjs enforces that structurally).
import { promises as fs } from "fs";
import * as path from "path";

export async function removeFrozenCopy(snapshotsDir: string, batchId: string): Promise<void> {
  const safe = batchId.replace(/[^A-Za-z0-9-]/g, "");
  if (!safe) return;
  const target = path.join(snapshotsDir, safe);
  // Defence in depth: the resolved target must be a direct child of the snapshots directory.
  if (path.dirname(path.resolve(target)) !== path.resolve(snapshotsDir)) return;
  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
}
