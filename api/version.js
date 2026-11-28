// Which version is live. Public, no user data, never cached.
export function versionOf(env) {
  const v = String(env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12);
  return /^[0-9a-f]{7,12}$/i.test(v) ? v : "dev";
}

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "GET only" });
  return res.status(200).json({ version: versionOf(process.env) });
}
