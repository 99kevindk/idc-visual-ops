/* =========================================================================
 *  tools/arch/push-api.mjs —— 用 GitHub REST API 完成"等效 git push"
 *  适用：本机到 github.com:443 被阻断（代理不可用），但 api.github.com 可达。
 *  特点：
 *    1) 空仓库先用 Contents API 建首个提交（GitHub 限制：空仓库不能用 Git Data API）；
 *    2) blob 内容寻址 → 上传后 sha 与本地一致；再按**完全相同的元数据**重建 commit，
 *       因此远端 commit sha 与本地 HEAD 一致 —— 本地/远端不会分叉，后续 git push 可继续用；
 *    3) 最后自动把本地分支与 origin/main 对齐并设置 upstream。
 *  用法：GH_TOKEN=xxx node tools/arch/push-api.mjs <owner>/<repo> [branch]
 * ========================================================================= */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = process.argv[2] || "99kevindk/idc-visual-ops";
const BRANCH = process.argv[3] || "main";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("缺少 GH_TOKEN（可执行 gh auth token 注入）"); process.exit(1); }
const API = "https://api.github.com";
const H = { authorization: "Bearer " + TOKEN, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "idc-visual-ops-push" };
const call = async (method, url, body) => {
  const res = await fetch(API + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text(); let json; try { json = JSON.parse(txt); } catch (e) { json = { raw: txt }; }
  if (!res.ok && res.status !== 404 && res.status !== 409) throw new Error(method + " " + url + " -> " + res.status + " " + String(json.message || txt).slice(0, 200));
  return { ok: res.ok, status: res.status, json };
};
const sh = (cmd, env) => execSync(cmd, { cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, env || {}) }).trim();
const git = (cmd, env) => sh("git " + cmd, env);
const pad = (s) => String(s).padEnd(14);

/* ---------- 0. 准备：本地 HEAD 信息 ---------- */
const headsha = git("rev-parse HEAD");
const fullTree = git("show -s --format=%T HEAD");
const msg = git("log -1 --format=%B").replace(/\s+$/, "");
const who = (() => { const m = git("log -1 --format=%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI").split("\x1f");
  return { an: m[0], ae: m[1], aI: m[2], cn: m[3], ce: m[4], cI: m[5] }; })();
const entries = git("ls-files -s").split("\n").filter(Boolean).map((l) => { const m = l.match(/^(\d{6})\s([0-9a-f]{40})\s\d\t(.+)$/); return { mode: m[1], sha: m[2], file: m[3] }; });
console.log("本地 HEAD " + headsha.slice(0, 10) + " · 树 " + fullTree.slice(0, 10) + " · 文件 " + entries.length);
console.log("提交信息首行：" + msg.split("\n")[0].slice(0, 60));

/* ---------- 1. 仓库是否为空 ---------- */
const repoInfo = (await call("GET", "/repos/" + REPO)).json;
console.log(pad("仓库") + repoInfo.full_name + " · " + repoInfo.visibility + " · 默认分支 " + repoInfo.default_branch);
const refProbe = await call("GET", "/repos/" + REPO + "/git/refs/heads/" + BRANCH);
let parentSha = null;
if (refProbe.ok) { parentSha = refProbe.json.object.sha; console.log(pad("现有分支") + BRANCH + " = " + parentSha.slice(0, 10) + "（将作为父提交）"); }

/* ---------- 2. 空仓库：用 Contents API 建首个提交，并在本地精确重建 ---------- */
let A = null;
if (!parentSha) {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"));
  const boot = await call("PUT", "/repos/" + REPO + "/contents/.gitignore",
    { message: "chore: initialize repository (.gitignore)", content: gi.toString("base64") });
  const bsha = boot.json.commit.sha;
  const bc = (await call("GET", "/repos/" + REPO + "/git/commits/" + bsha)).json;
  console.log(pad("bootstrap") + bsha.slice(0, 10) + " · tree " + bc.tree.sha.slice(0, 10) + " · " + new Date(bc.author.date).toLocaleString("zh-CN"));
  // 在本地用完全相同的内容/元数据重建同一个提交（git 提交对象是确定性的）
  const idx = path.join(ROOT, ".git", "tmp-boot-index");
  try { fs.existsSync(idx) && fs.unlinkSync(idx); } catch (e) {}
  const env = { GIT_INDEX_FILE: idx, GIT_AUTHOR_NAME: bc.author.name, GIT_AUTHOR_EMAIL: bc.author.email, GIT_AUTHOR_DATE: bc.author.date,
                GIT_COMMITTER_NAME: bc.committer.name, GIT_COMMITTER_EMAIL: bc.committer.email, GIT_COMMITTER_DATE: bc.committer.date };
  git("add -- .gitignore", env);
  const btree = git("write-tree", env);
  const bshaLocal = git("commit-tree " + btree + " -m " + JSON.stringify(bc.message.replace(/\s+$/, "")), env);
  try { fs.unlinkSync(idx); } catch (e) {}
  console.log(pad("本地重建") + bshaLocal.slice(0, 10) + (bshaLocal === bsha ? " ✓ 与远端一致（历史可精确对齐）" : " ⚠ 不一致，将按远端 sha 继续"));
  A = bshaLocal === bsha ? bshaLocal : bsha;   // 以远端为准
  parentSha = A;
}

/* ---------- 3. 全量上传 blob（内容寻址） ---------- */
let done = 0, bad = 0;
const CONC = 6;
const upload = async (list) => {
  for (const e of list) {
    const buf = fs.readFileSync(path.join(ROOT, e.file));
    const r = await call("POST", "/repos/" + REPO + "/git/blobs", { content: buf.toString("base64"), encoding: "base64" });
    if (r.json.sha !== e.sha) { bad++; console.warn("  ⚠ " + e.file + " sha 不一致"); }
    done++;
    if (done % 25 === 0 || done === entries.length) console.log(pad("上传 blob") + done + "/" + entries.length);
  }
};
await Promise.all(Array.from({ length: CONC }, (_, i) => upload(entries.filter((_, n) => n % CONC === i))));
const treeRes = await call("POST", "/repos/" + REPO + "/git/trees", { tree: entries.map((e) => ({ path: e.file, mode: e.mode, type: "blob", sha: e.sha })) });
console.log(pad("tree") + treeRes.json.sha.slice(0, 10) + (treeRes.json.sha === fullTree ? " ✓ 与本地一致" : " ⚠ 与本地不同"));

/* ---------- 4. 建 commit（与本地同元数据 → 同 sha） ---------- */
const commitRes = await call("POST", "/repos/" + REPO + "/git/commits", {
  message: msg, tree: treeRes.json.sha, parents: parentSha ? [parentSha] : [],
  author: { name: who.an, email: who.ae, date: who.aI }, committer: { name: who.cn, email: who.ce, date: who.cI },
});
const remoteSha = commitRes.json.sha;
console.log(pad("commit") + remoteSha.slice(0, 10) + (remoteSha === headsha ? " ✓ 与本地 HEAD 完全一致（无分叉）" : " ⚠ 与本地 HEAD 不同（本地 " + headsha.slice(0, 10) + "）"));

/* ---------- 5. 更新分支引用 ---------- */
if (refProbe.ok) { await call("PATCH", "/repos/" + REPO + "/git/refs/heads/" + BRANCH, { sha: remoteSha, force: true }); console.log(pad("分支") + BRANCH + " 已更新"); }
else { await call("POST", "/repos/" + REPO + "/git/refs", { ref: "refs/heads/" + BRANCH, sha: remoteSha }); console.log(pad("分支") + BRANCH + " 已创建"); }

/* ---------- 6. 本地与远端对齐（必要时用相同元数据在本地重建提交，使两边 sha 一致） ---------- */
let aligned = remoteSha === headsha;
if (!aligned) {
  const env = { GIT_AUTHOR_NAME: who.an, GIT_AUTHOR_EMAIL: who.ae, GIT_AUTHOR_DATE: who.aI,
                GIT_COMMITTER_NAME: who.cn, GIT_COMMITTER_EMAIL: who.ce, GIT_COMMITTER_DATE: who.cI };
  const msgFile = path.join(ROOT, ".git", "tmp-msg");
  fs.writeFileSync(msgFile, msg);
  const localB = git("commit-tree " + fullTree + (parentSha ? " -p " + parentSha : "") + " -F " + JSON.stringify(msgFile), env);
  fs.unlinkSync(msgFile);
  if (localB === remoteSha) {
    git("update-ref refs/heads/" + BRANCH + " " + localB);
    git("reset --mixed " + localB);
    aligned = true;
    console.log(pad("本地重建") + localB.slice(0, 10) + " ✓ 已用相同元数据重建提交，本地=远端");
  } else {
    console.log(pad("本地重建") + localB.slice(0, 10) + " ⚠ 与远端 " + remoteSha.slice(0, 10) + " 不同（将提示手动对齐）");
  }
}
if (aligned) {
  git("update-ref refs/remotes/origin/" + BRANCH + " " + remoteSha);
  git("config branch." + BRANCH + ".remote origin");
  git("config branch." + BRANCH + ".merge refs/heads/" + BRANCH);
  console.log(pad("本地对齐") + "origin/" + BRANCH + " 已指向同一提交，upstream 已设置（后续 git push 正常可用）");
} else {
  console.log(pad("本地对齐") + "远端为 " + remoteSha.slice(0, 10) + "；网络恢复后执行：git fetch origin && git reset --hard origin/" + BRANCH);
}

/* ---------- 7. 远端校验 ---------- */
const check = (await call("GET", "/repos/" + REPO + "/git/trees/" + remoteSha + "?recursive=1")).json;
const blobs = check.tree.filter((t) => t.type === "blob");
console.log(pad("远端校验") + "文件 " + blobs.length + " 个 · 截断=" + !!check.truncated + (bad ? " · blob 异常 " + bad : ""));
const r2 = (await call("GET", "/repos/" + REPO)).json;
console.log(pad("完成") + r2.html_url + " · " + r2.visibility + " · 默认分支 " + r2.default_branch + " · " + (r2.size / 1024).toFixed(2) + " MB");