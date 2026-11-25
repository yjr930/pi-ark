import assert from "node:assert/strict";
import { approvalCloseReasonText, detectDeleteCommand, formatApprovalDenialReason } from "../apps/server/src/tool-approvals.ts";

function detected(script: string): string | undefined {
  return detectDeleteCommand(script)?.matched;
}

// File-deleting commands are detected through wrappers, pipes, lists and nested shells.
assert.equal(detected("rm -rf build"), "rm");
assert.equal(detected("rmdir empty"), "rmdir");
assert.equal(detected("unlink link"), "unlink");
assert.equal(detected("shred -u secret.txt"), "shred");
assert.equal(detected("/bin/rm -f notes.txt"), "rm");
assert.equal(detected("cd packages/web && rm -rf dist"), "rm");
assert.equal(detected("npm test; rm -rf coverage"), "rm");
assert.equal(detected("cat files.txt | xargs rm -f"), "rm");
assert.equal(detected("echo file | xargs -0 -n 1 rm"), "rm");
assert.equal(detected("sudo -u root rm -rf /var/tmp/cache"), "rm");
assert.equal(detected("timeout 30 rm -rf tmp"), "rm");
assert.equal(detected("env NODE_ENV=test rm -f out.log"), "rm");
assert.equal(detected("bash -c 'rm -rf build'"), "rm");
assert.equal(detected("sh -lc \"rm -rf build\""), "rm");
assert.equal(detected("echo $(rm -rf build)"), "rm");
assert.equal(detected("if [ -d cache ]; then rm -rf cache; fi"), "rm");
assert.equal(detected('for f in *.log; do rm -f "$f"; done'), "rm");
assert.equal(detected("find . -name '*.log' -delete"), "find -delete");
assert.equal(detected("find . -name '*.log' -exec rm {} \\;"), "find -exec rm");
assert.equal(detected("git clean -fdx"), "git clean");
assert.equal(detected("git -C ./repo clean --force"), "git clean");
assert.equal(detected("git rm old.txt"), "git rm");

// Commands that keep files stay out of the check, including quoted text and dry runs.
assert.equal(detected("ls -la"), undefined);
assert.equal(detected("npm run clean"), undefined);
assert.equal(detected('echo "rm -rf /"'), undefined);
assert.equal(detected("grep -r rm ."), undefined);
assert.equal(detected("rg 'rm -rf' docs"), undefined);
assert.equal(detected("git clean -n"), undefined);
assert.equal(detected("git clean -ndx"), undefined);
assert.equal(detected("git rm --cached old.txt"), undefined);
assert.equal(detected("git commit -m \"remove old notes\""), undefined);
assert.equal(detected("docker run --rm image"), undefined);
assert.equal(detected('python -c "import shutil; shutil.rmtree(\'build\')"'), undefined);
assert.equal(detected(""), undefined);

assert.equal(approvalCloseReasonText("denied"), "用户拒绝了该删除命令");
assert.equal(approvalCloseReasonText("aborted"), "会话被中止，该命令没有执行");
assert.equal(approvalCloseReasonText("deleted"), "会话被删除，该命令没有执行");
assert.equal(approvalCloseReasonText("rollback"), "会话回滚取消了该命令");
assert.equal(approvalCloseReasonText("unavailable"), "无法取得审批界面，该命令没有执行");
assert.equal(formatApprovalDenialReason("rm -rf build", "denied"), "[删除审批] 用户拒绝了该删除命令。命令：rm -rf build");

console.log("Delete command detection and approval text checks passed.");
