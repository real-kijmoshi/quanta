import { init, close } from "../lib/store.mjs";
import { initAuth, resetAccountPassword, hosted } from "../lib/auth.mjs";

try {
  if (!hosted) throw new Error("Set QUANTA_AUTH=1 and QUANTA_PUBLIC_URL for the hosted workspace");
  await init(); // Acquires the workspace lock; refuses while the server is running.
  await initAuth();
  await resetAccountPassword(process.argv[2], process.env.QUANTA_RESET_PASSWORD);
  console.log("Password updated. All sessions for this account have been revoked.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await close(); }
