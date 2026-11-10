import {
  getBinaryNodeChild,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  S_WHATSAPP_NET,
  type BinaryNode,
  type WASocket,
} from '@whiskeysockets/baileys';

const PROFILE_PICTURE_TIMEOUT_MS = 3_000;
const TOKEN_BUCKET_SECONDS = 604_800;
const TOKEN_BUCKET_COUNT = 4;

/**
 * Apply the profile-picture fix from Baileys PR #2607 without replacing the SDK.
 * Upstream commit: 731cd6b5d1991a16d0c65072fd3107c43968e4a9.
 * Reads existing tokens only; the server still decides whether a photo is visible.
 */
export async function fetchWhatsAppProfilePicture(
  sock: WASocket,
  jid: string,
  isCurrent: () => boolean,
  timeoutMs = PROFILE_PICTURE_TIMEOUT_MS
): Promise<string | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;

  const budget = Math.min(timeoutMs, PROFILE_PICTURE_TIMEOUT_MS);
  const deadline = Date.now() + budget;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => !finished && Date.now() < deadline && isCurrent();

  const lookup = async (): Promise<string | null> => {
    if (!current() || typeof jid !== 'string' || jid.length > 64) return null;
    const target = jidNormalizedUser(jid);
    if ((!isPnUser(target) && !isLidUser(target)) || !/^\d+@(s\.whatsapp\.net|lid)$/.test(target)) {
      return null;
    }

    const me = sock.authState.creds.me;
    const isSelf =
      me &&
      (target === jidNormalizedUser(me.id) || (me.lid && target === jidNormalizedUser(me.lid)));
    const picture: BinaryNode = { tag: 'picture', attrs: { type: 'preview', query: 'url' } };

    if (sock.serverProps.profilePicPrivacyToken && !isSelf) {
      const storageJid = isLidUser(target)
        ? target
        : ((await sock.signalRepository.lidMapping.getLIDForPN(target)) ?? target);
      if (!current()) return null;

      const entries = await sock.authState.keys.get('tctoken', [storageJid]);
      if (!current()) return null;
      const entry = entries[storageJid];
      const timestamp =
        typeof entry?.timestamp === 'string' && /^\d+$/.test(entry.timestamp)
          ? Number(entry.timestamp)
          : NaN;
      const currentBucket = Math.floor(Date.now() / 1000 / TOKEN_BUCKET_SECONDS);
      const cutoff = (currentBucket - (TOKEN_BUCKET_COUNT - 1)) * TOKEN_BUCKET_SECONDS;

      // Mirror the upstream weekly expiry window. Never strip a valid token,
      // refresh it, or mutate the key store to make a picture request succeed.
      if (
        entry?.token instanceof Uint8Array &&
        entry.token.length > 0 &&
        Number.isSafeInteger(timestamp) &&
        timestamp >= cutoff
      ) {
        picture.content = [
          { tag: 'tctoken', attrs: { t: String(timestamp) }, content: entry.token },
        ];
      }
    }

    if (!current()) return null;
    const response = await sock.query(
      {
        tag: 'iq',
        attrs: {
          target,
          to: S_WHATSAPP_NET,
          type: 'get',
          xmlns: 'w:profile:picture',
        },
        content: [picture],
      },
      Math.max(1, deadline - Date.now())
    );
    if (!current()) return null;
    const url = getBinaryNodeChild(response, 'picture')?.attrs.url;
    return typeof url === 'string' && url.length > 0 ? url : null;
  };

  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        finished = true;
        resolve(null);
      }, budget);
    });
    return await Promise.race([lookup(), timeout]);
  } catch {
    // Hidden/missing photos, failed token reads and transport errors are optional.
    // Never log tokens, profile URLs or raw provider exceptions.
    return null;
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
