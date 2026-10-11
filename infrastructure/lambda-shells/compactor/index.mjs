// Placeholder for the compactor Lambda. Logs the schedule trigger and exits
// successfully without doing any work. The real snapshot-compaction handler
// is bundled from apps/api and replaces this shell.

export const handler = async (event) => {
  console.log(JSON.stringify({
    msg: "compactor placeholder; no compaction performed",
    eventTime: event?.time ?? new Date().toISOString(),
  }));
  return { ok: true, placeholder: true };
};
