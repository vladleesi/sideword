"use strict";

// The client restores its selected conversation and initial position itself.
if (typeof history !== "undefined") history.scrollRestoration = "manual";

// New test protocol: keep prior device/history records untouched in their old DB.
const DB_NAME = "sideword-test-client-p256-payload-v1";
const STORE_NAME = "device";
const IDENTITY_KEY = "identity";
const HISTORY_PREFIX = "history:";
const POLL_INTERVAL_MS = 4000;
const REQUEST_TIMEOUT_MS = 15000;
// Local display preference only; it never changes delivery, receipts or stored history.
const IMAGE_PREVIEW_KEY = "sideword-client-image-previews";
// Link previews are on by default; an explicit "off" on this device is kept.
const LINK_PREVIEW_KEY = "sideword-client-link-previews";
// Memory only, for the sender's draft; sent previews live in the message's encrypted history.
const LINK_PREVIEW_CACHE_SIZE = 20;
const LINK_PREVIEW_RETRY_MS = 10000;
const LINK_PREVIEW_PARALLEL = 3;
// Draft URLs are prefetched once they look complete: followed by text, pasted, or after a pause.
const LINK_PREFETCH_IDLE_MS = 700;
// Wide images become a banner; others a small square thumbnail.
// Every recipient gets its own copy of the image, so even banners stay at 24 KB.
const LINK_BANNER = { bytes: 24 * 1024, dimension: 320 };
const LINK_THUMBNAIL = { bytes: 24 * 1024, dimension: 160 };
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VIEWER_ZOOM_LEVELS = [1, 1.5, 2, 3, 4];
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const elements = {
  activationForm: document.querySelector("#activation-form"),
  chatList: document.querySelector("#chat-list"),
  clientPanel: document.querySelector("#client-panel"),
  connectionState: document.querySelector("#connection-state"),
  connectionLabel: document.querySelector("#connection-label"),
  detailsButton: document.querySelector("#conversation-details-button"),
  detailsDialog: document.querySelector("#conversation-details"),
  deviceDialog: document.querySelector("#device-settings"),
  devicePublicId: document.querySelector("#device-public-id"),
  keyWarning: document.querySelector("#key-change-warning"),
  conversation: document.querySelector("#conversation"),
  conversationKind: document.querySelector("#conversation-kind"),
  conversationTitle: document.querySelector("#conversation-title"),
  displayName: document.querySelector("#display-name"),
  error: document.querySelector("#error-message"),
  identityLabel: document.querySelector("#identity-label"),
  inviteToken: document.querySelector("#invite-token"),
  loadingPanel: document.querySelector("#loading-panel"),
  roomPassword: document.querySelector("#join-password"),
  activationError: document.querySelector("#activation-error"),
  attachmentInput: document.querySelector("#attachment-input"),
  attachmentButton: document.querySelector("#attachment-button"),
  attachmentPreview: document.querySelector("#attachment-preview"),
  attachmentLabel: document.querySelector("#attachment-label"),
  attachmentSize: document.querySelector("#attachment-size"),
  attachmentCancel: document.querySelector("#attachment-cancel"),
  attachmentTile: document.querySelector("#attachment-tile"),
  composerError: document.querySelector("#composer-error"),
  emojiButton: document.querySelector("#emoji-button"),
  emojiPicker: document.querySelector("#emoji-picker"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#message-input"),
  messageList: document.querySelector("#message-list"),
  messageDetails: document.querySelector("#message-details"),
  participantCount: document.querySelector("#participant-count"),
  participantKeys: document.querySelector("#participant-keys"),
  refreshButton: document.querySelector("#refresh-button"),
  resetButton: document.querySelector("#reset-button"),
  sendButton: document.querySelector("#send-button"),
  setupPanel: document.querySelector("#setup-panel"),
  status: document.querySelector("#status-message"),
  imagePreviewReveal: document.querySelector("#image-previews-reveal"),
  imagePreviewAuto: document.querySelector("#image-previews-auto"),
  linkPreviewsOff: document.querySelector("#link-previews-off"),
  linkPreviewsOn: document.querySelector("#link-previews-on"),
  linkPreviewsUnavailable: document.querySelector("#link-previews-unavailable"),
  imageViewer: document.querySelector("#image-viewer"),
  imageStage: document.querySelector("#image-stage"),
  imageViewerStatus: document.querySelector("#image-viewer-status"),
  imageViewerError: document.querySelector("#image-viewer-error"),
  imageZoomIn: document.querySelector("#image-zoom-in"),
  imageZoomOut: document.querySelector("#image-zoom-out"),
  imageZoomFit: document.querySelector("#image-zoom-fit"),
  waitingNotice: document.querySelector("#waiting-notice"),
};

let selectedFile = null;
let sendingMessage = false;
let queuedSocketBytes = 0;
let queuedSocketEvents = 0;
const failedMessageRetries = new Map();
const downloadUrls = new Map();
const mediaPreviews = globalThis.SidewordMedia?.createManager(scheduleVisiblePreviews);
const shownPreviews = new Set();
const receivedMedia = new Map();
// Message ID -> preview that arrived in a later follow-up from the message's sender.
const receivedPreviews = new Map();
// Reactions, rebuilt from encrypted history: chat ID -> target message entry ID -> reactor
// public ID -> { emoji (null when removed), rev, messageId (own operations only) }.
const reactionsByChat = new Map();
const REACTION_NAMES = ["Thumbs up", "Red heart", "Face with tears of joy", "Thinking face", "Crying face"];
const MAX_REACTION_NAMES = 10;
let reactionQueue = Promise.resolve();
let reactionPicker = null;
const mediaFailures = new Map();
const mediaUploadStates = new Map();
let mediaTimer = null;
let previewTimer = null;
let imagePreviewMode = readImagePreviewMode();
let linkPreviewMode = readLinkPreviewMode();
let linkPreviewsAvailable = false;
// Memory only: href -> checked preview or null after failure; never uploaded or persisted.
const linkPreviewResults = new Map();
// href -> { link, messages }: queued, or in flight; Blob URLs are owned per message.
const linkPreviewQueue = new Map();
const linkPreviewPending = new Map();
const linkPreviewUrls = new Map();
let linkPreviewGeneration = 0;
let linkPreviewDrainScheduled = false;
// Addresses fetched only for the unsent draft; discarded if they leave the draft before sending.
const draftLinkPreviews = new Set();
let draftPrefetchTimer = null;
// Payload preview -> decoded card data, so re-renders do not decode images again.
const decodedLinkPreviews = new WeakMap();
// href -> sent messages still waiting for their preview; it follows in an encrypted message.
const sentLinkPreviews = new Map();
const LINK_CARD_ANIMATION_MS = 200;
// In-memory reveals only: reload returns incoming images to the selected privacy mode.
const revealedImages = new Set();
let requestedPreview = null;
const imageViewer = { token: 0, entry: null, chatId: null, trigger: null, image: null, url: null,
  width: 0, height: 0, zoom: 1 };
const composerPreview = { token: 0, image: null, url: null, optimizing: false };
let transferringMedia = false;
// Created once the composer handlers below are defined.
let emojiPicker = null;
let transferController = null;
let identity = null;
let chats = [];
let selectedChatId = null;
let invitePending = false;
let synchronizing = false;
let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let heartbeatTimer = null;
let socketAuthTimer = null;
let pageActive = true;
let accessDeadline = null;
let inboundQueue = Promise.resolve();
const messagesByChat = new Map();
const renderedMessages = new Map();
let renderedChatId;
const seenMessageIds = new Set();
const seenReceiptIds = new Set();
const processingMessageIds = new Set();
const failedMessageReasons = new Map();
const pendingReadsByChat = new Map();
const pendingDeliveries = new Map();
const pendingReceiptIds = new Map();
const messageMetadata = new Map();
const loadedHistoryKeys = new Set();
const deliveryReferences = new Map();
const acknowledgedDeliveries = new Set();
const acknowledgedReads = new Set();
const outgoingAttempts = new Map();
const visibleMessageNodes = new Set();
const viewTimers = new Map();
let openMessageDetails = null;
let messageDetailsTrigger = null;
let statusPollCursor = 0;
let messageProfileReady = false;
const participantNodes = new Map();
let participantChatId;
const presenceByChat = new Map();
let presenceUntil = 0;
let presenceTimer = null;
let followResizedMessages = true;

elements.messageList.addEventListener("scroll", () => {
  if (!conversationVisible()) return;
  const list = elements.messageList;
  followResizedMessages = list.scrollHeight - list.clientHeight - list.scrollTop <= 32;
  list.setAttribute("data-follow-latest", String(followResizedMessages));
  positionReactionPicker();
  refreshVisibleReads();
  scheduleVisiblePreviews();
});
let messageResizeObserver = null;
if (typeof ResizeObserver === "function") {
  messageResizeObserver = new ResizeObserver(() => {
    if (conversationVisible() && followResizedMessages) {
      elements.messageList.scrollTop = elements.messageList.scrollHeight;
    }
    refreshVisibleReads();
    scheduleVisiblePreviews();
  });
  messageResizeObserver.observe(elements.messageList);
}

// Dynamic viewport units alone do not account for every mobile keyboard. iOS Safari
// keeps the layout viewport and pans the visual viewport instead, so the workspace
// follows both its height and its offset. Pinch zoom (scale above 1) is left alone.
let workspaceViewportHeight = null;
let workspaceViewportOffsetTop = null;
function updateWorkspaceViewport() {
  const viewport = window.visualViewport;
  positionMessageDetails();
  positionReactionPicker();
  if (!viewport || Math.abs(viewport.scale - 1) > .01) return;
  const height = Math.round(viewport.height);
  const offsetTop = Math.max(0, Math.round(viewport.offsetTop || 0));
  const shrank = workspaceViewportHeight !== null && height < workspaceViewportHeight;
  if (height !== workspaceViewportHeight) {
    workspaceViewportHeight = height;
    document.documentElement.style.setProperty("--visual-viewport-height", `${height}px`);
  }
  if (offsetTop !== workspaceViewportOffsetTop) {
    workspaceViewportOffsetTop = offsetTop;
    document.documentElement.style.setProperty("--visual-viewport-offset-top", `${offsetTop}px`);
  }
  // An opening keyboard can cover the field that caused it once the workspace shrinks.
  const focused = document.activeElement;
  if (shrank && ["INPUT", "TEXTAREA"].includes(focused?.tagName) && focused.scrollIntoView) {
    focused.scrollIntoView({ block: "nearest" });
  }
}
window.visualViewport?.addEventListener("resize", updateWorkspaceViewport);
window.visualViewport?.addEventListener("scroll", updateWorkspaceViewport);
updateWorkspaceViewport();

// Native modal dialogs provide focus containment and Escape handling.
function bindDialog(dialog, openButton, closeButton) {
  closeOnBackdrop(dialog);
  openButton.addEventListener("click", () => {
    if (!dialog.open) dialog.showModal();
    refreshVisibleReads();
  });
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    const target = openButton === elements.detailsButton && elements.clientPanel.hidden
      ? elements.inviteToken : openButton;
    target.focus({ preventScroll: true });
  });
}

function closeOnBackdrop(dialog) {
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
bindDialog(elements.detailsDialog, elements.detailsButton,
  document.querySelector("#close-conversation-details"));
bindDialog(elements.deviceDialog, document.querySelector("#device-settings-button"),
  document.querySelector("#close-device-settings"));
document.querySelector("#close-message-details").addEventListener("click", () => elements.messageDetails.close());
elements.messageDetails.addEventListener("close", () => {
  openMessageDetails = null;
  const fallback = elements.messageInput.disabled ? elements.conversationTitle : elements.messageInput;
  const target = messageDetailsTrigger?.isConnected === false ? fallback : messageDetailsTrigger;
  target?.focus({ preventScroll: true });
  messageDetailsTrigger = null;
  refreshVisibleReads();
});
closeOnBackdrop(elements.messageDetails);
elements.messageDetails.addEventListener("toggle", () => positionMessageDetails(), true);
elements.detailsDialog.addEventListener("close", refreshVisibleReads);
closeOnBackdrop(elements.imageViewer);
document.querySelector("#close-image-viewer").addEventListener("click", () => elements.imageViewer.close());
elements.imageViewer.addEventListener("close", () => {
  imageViewer.token++;
  releaseViewerImage();
  imageViewer.entry = null;
  const trigger = imageViewer.trigger;
  imageViewer.trigger = null;
  const fallback = elements.messageInput.disabled ? elements.conversationTitle : elements.messageInput;
  (trigger && trigger.isConnected !== false ? trigger : fallback).focus({ preventScroll: true });
  refreshVisibleReads();
});
elements.imageZoomIn.addEventListener("click", () => stepViewerZoom(1));
elements.imageZoomOut.addEventListener("click", () => stepViewerZoom(-1));
elements.imageZoomFit.addEventListener("click", () => setViewerZoom(1));
elements.imageStage.addEventListener("dblclick", () => setViewerZoom(imageViewer.zoom === 1 ? 2 : 1));
elements.imageViewer.addEventListener("keydown", event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const step = { "+": 1, "=": 1, "-": -1, "_": -1 }[event.key];
  if (step) { event.preventDefault(); stepViewerZoom(step); }
  else if (event.key === "0") { event.preventDefault(); setViewerZoom(1); }
});
document.querySelector("#image-download").addEventListener("click", () => {
  if (imageViewer.entry?.attachment) downloadAttachment(imageViewer.entry.attachment, elements.imageViewerError);
});
elements.imagePreviewReveal.addEventListener("change", () => {
  if (elements.imagePreviewReveal.checked) applyImagePreviewMode("reveal", true);
});
elements.imagePreviewAuto.addEventListener("change", () => {
  if (elements.imagePreviewAuto.checked) applyImagePreviewMode("auto", true);
});
elements.linkPreviewsOff.checked = linkPreviewMode === "off";
elements.linkPreviewsOn.checked = linkPreviewMode === "on";
elements.linkPreviewsOff.addEventListener("change", () => {
  if (elements.linkPreviewsOff.checked) applyLinkPreviewMode("off", true);
});
elements.linkPreviewsOn.addEventListener("change", () => {
  if (elements.linkPreviewsOn.checked) applyLinkPreviewMode("on", true);
});
window.addEventListener("storage", event => {
  if (event.key === IMAGE_PREVIEW_KEY || event.key === null) applyImagePreviewMode(readImagePreviewMode());
  if (event.key === LINK_PREVIEW_KEY || event.key === null) applyLinkPreviewMode(readLinkPreviewMode());
});
elements.deviceDialog.addEventListener("close", refreshVisibleReads);

function mobileWorkspace() {
  return Boolean(window.matchMedia?.("(max-width: 760px)").matches);
}

function conversationVisible() {
  return !elements.clientPanel.hidden
    && (!mobileWorkspace() || elements.clientPanel.dataset.mobileView === "conversation");
}

function rememberChatView(view, chatId = selectedChatId) {
  if (!mobileWorkspace() || !identity?.publicId || !globalThis.history?.replaceState) return;
  try {
    // Per-tab navigation only: never copy identity keys, credentials or messages.
    history.replaceState({ ...history.state,
      sidewordChatView: { publicId: identity.publicId, chatId, view } }, "");
  } catch { /* Navigation remains usable if the browser refuses a state save. */ }
}

function restoreChatView() {
  selectedChatId = identity?.activeInviteChatId || null;
  if (!mobileWorkspace() || !identity?.publicId) return;
  const saved = globalThis.history?.state?.sidewordChatView;
  const validId = saved?.chatId === null || (Number.isSafeInteger(saved?.chatId) && saved.chatId > 0);
  const validView = saved?.view === "chats" || (saved?.view === "conversation" && saved.chatId !== null);
  if (saved?.publicId === identity?.publicId && validId && validView) {
    selectedChatId = saved.chatId;
    elements.clientPanel.setAttribute("data-mobile-view", saved.view);
  } else if (selectedChatId && identity?.token) {
    elements.clientPanel.setAttribute("data-mobile-view", "conversation");
  }
}

document.querySelector("#back-to-chats").addEventListener("click", () => {
  elements.clientPanel.dataset.mobileView = "chats";
  refreshVisibleReads();
  rememberChatView("chats");
  (elements.chatList.querySelector(".active") || elements.refreshButton).focus({ preventScroll: true });
});

function publicDetail(label, value, feedback) {
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  const code = document.createElement("code");
  code.textContent = value;
  code.tabIndex = 0;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "button subtle";
  copy.textContent = `Copy ${label.toLowerCase()}`;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      feedback.textContent = `${label} copied.`;
    } catch {
      // No fallback upload or hidden form: leave the complete value selectable.
      code.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      feedback.textContent = "Copy unavailable. The full value is selected; copy it manually.";
    }
    feedback.hidden = false;
  });
  description.append(code, copy);
  return { term, description, code, copy };
}

function participantPresence(chatId, publicId) {
  const snapshot = presenceByChat.get(chatId);
  if (!snapshot || performance.now() >= presenceUntil || !snapshot.members.has(publicId)) return "unknown";
  return snapshot.online.has(publicId) ? "online" : "offline";
}

function renderPresence() {
  const chat = chats.find(item => item.id === selectedChatId);
  if (!chat) {
    elements.participantCount.textContent = "";
    return;
  }
  const states = chat.participants.map(peer => participantPresence(chat.id, peer.public_id));
  const known = states.length > 0 && !states.includes("unknown")
    && presenceByChat.get(chat.id)?.members.size === states.length;
  elements.participantCount.textContent = known
    ? `${states.filter(state => state === "online").length} of ${states.length} online`
    : `${states.length} participant${states.length === 1 ? "" : "s"} · Presence unknown`;
  for (const peer of chat.participants) {
    const item = participantNodes.get(peer.public_id);
    if (!item) continue;
    const state = participantPresence(chat.id, peer.public_id);
    item.presence.className = `participant-presence ${state}`;
    item.presence.textContent = state === "unknown" ? "Presence unknown" : state === "online" ? "Online" : "Offline";
  }
}

function clearPresence() {
  presenceByChat.clear();
  presenceUntil = 0;
  if (presenceTimer !== null) window.clearTimeout(presenceTimer);
  presenceTimer = null;
  renderPresence();
}

function receivePresence(payload) {
  // A complete snapshot replaces all prior state; never persist activity.
  clearPresence();
  if (navigator.onLine === false) return;
  if (!Number.isFinite(payload.valid_for_ms) || payload.valid_for_ms <= 0
      || payload.valid_for_ms > 35000 || !Array.isArray(payload.chats)) return;
  for (const snapshot of payload.chats) {
    if (!Number.isInteger(snapshot.chat_id) || !Array.isArray(snapshot.online)
        || !Array.isArray(snapshot.participants)
        || !snapshot.participants.every(id => typeof id === "string")
        || !snapshot.online.every(id => typeof id === "string" && snapshot.participants.includes(id))) {
      clearPresence();
      return;
    }
    presenceByChat.set(snapshot.chat_id, {
      online: new Set(snapshot.online), members: new Set(snapshot.participants),
    });
  }
  presenceUntil = performance.now() + payload.valid_for_ms;
  presenceTimer = window.setTimeout(clearPresence, payload.valid_for_ms);
  renderPresence();
}

function renderParticipantDetails(chat) {
  if (participantChatId !== chat?.id) {
    elements.participantKeys.replaceChildren();
    participantNodes.clear();
    participantChatId = chat?.id;
    document.querySelector("#details-copy-status").hidden = true;
  }
  document.querySelector("#details-conversation-title").textContent = chat ? chatName(chat) : "";
  const ids = new Set(chat?.participants.map(peer => peer.public_id) || []);
  for (const [id, item] of participantNodes) {
    if (!ids.has(id)) { item.node.remove(); participantNodes.delete(id); }
  }
  for (const [index, peer] of (chat?.participants || []).entries()) {
    let item = participantNodes.get(peer.public_id);
    if (!item) {
      const node = document.createElement("details");
      node.className = "participant";
      const summary = document.createElement("summary");
      const name = document.createElement("span");
      name.className = "participant-name";
      const state = document.createElement("span");
      const presence = document.createElement("span");
      summary.append(name, presence, state);
      const values = document.createElement("dl");
      values.className = "technical-details";
      const feedback = document.querySelector("#details-copy-status");
      const id = publicDetail("Public ID", peer.public_id, feedback);
      const fingerprint = publicDetail("Fingerprint", "", feedback);
      values.append(id.term, id.description, fingerprint.term, fingerprint.description);
      node.append(summary, values);
      item = { node, name, state, fingerprint, presence };
      participantNodes.set(peer.public_id, item);
    }
    const own = peer.public_id === identity?.publicId;
    item.name.textContent = `${peer.display_name?.trim() || "Unnamed participant"}${own ? " (this device)" : ""}`;
    // Only states that need attention are shown; routine pinned keys stay quiet.
    item.state.textContent = peer.key_changed ? "Key changed · messaging blocked"
      : !peer.local_fingerprint ? "Key not checked" : "";
    item.state.className = `key-state${peer.key_changed ? " changed" : ""}`;
    item.fingerprint.code.textContent = peer.local_fingerprint || "not checked";
    item.fingerprint.copy.disabled = !peer.local_fingerprint;
    if (elements.participantKeys.children[index] !== item.node) {
      elements.participantKeys.insertBefore(item.node, elements.participantKeys.children[index] || null);
    }
  }
  renderPresence();
}

// Only locally written explanations may reach the UI; request bodies and raw
// browser/server exception text can contain credentials or message data.
class ClientError extends Error {}

class DeviceStorageError extends ClientError {
  constructor(message = "The browser could not read your saved chat keys from site storage. The saved device record is unreadable. Keep existing device data; do not use Reset device.") {
    super(message);
    this.name = "DeviceStorageError";
  }
}

function storageFailure(error, explanation) {
  if (error instanceof DOMException && ["QuotaExceededError", "SecurityError"].includes(error.name)) {
    return new ClientError(errorMessage(error));
  }
  return new ClientError(explanation);
}

function unreadableIdentity(value) {
  return value === null || Boolean(value && (
    (Object.hasOwn(value, "privateKey") && !value.privateKey)
    || (Object.hasOwn(value, "storageKey") && !value.storageKey)
  ));
}

function bytesToBase64(bytes) {
  return SidewordProtocol.bytesToBase64(bytes);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageFailure(request.error, "The browser could not open local chat storage."));
  });
}

async function readIdentity() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(IDENTITY_KEY);
    let value;
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => {
      database.close();
      // Missing records return undefined. WebKit can return null when it
      // cannot deserialize a saved CryptoKey; preserve that record.
      if (unreadableIdentity(value)) reject(new DeviceStorageError());
      else resolve(value || null);
    };
    transaction.onerror = transaction.onabort = () => {
      database.close();
      reject(storageFailure(transaction.error || request.error, "The browser could not finish reading your saved device data. The saved login was not loaded."));
    };
  });
}

async function writeIdentity(value, updateSession = false) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const current = store.get(IDENTITY_KEY);
    let failure;
    current.onsuccess = () => {
      if (unreadableIdentity(current.result)) {
        failure = new DeviceStorageError();
        transaction.abort();
        return;
      }
      // Routine profile/history updates must not overwrite a newer rotation
      // committed by another tab while a network request was in flight.
      if (!updateSession && current.result && current.result.publicId === value.publicId) {
        for (const field of ["token", "suspendedToken", "refreshCredential", "sessionId",
          "tokenExpiresAt", "sessionExpiresAt", "pendingRefreshCredential",
          "activeInviteToken", "activeInviteChatId"]) {
          if (Object.hasOwn(current.result, field)) value[field] = current.result[field];
          else delete value[field];
        }
      }
      store.put(value, IDENTITY_KEY);
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = transaction.onabort = () => {
      database.close();
      reject(failure || storageFailure(transaction.error, "The browser could not save your device keys or login in local storage."));
    };
  });
}

async function clearIdentity() {
  stopMediaTransfers();
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(storageFailure(transaction.error, "The browser could not remove local device data."));
  });
}

async function generateIdentity() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = pair.privateKey;
  const storageKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return {
    privateKey,
    publicKey: bytesToBase64(publicKey),
    storageKey,
    token: null,
    publicId: null,
  };
}

async function ensureStorageKey() {
  if (!identity || identity.storageKey) return;
  identity.storageKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await writeIdentity(identity);
}

async function verifyIdentityPersistence() {
  const stored = await readIdentity();
  if (!stored?.privateKey || !stored.storageKey) throw new DeviceStorageError();
  if (stored.publicId !== identity.publicId || stored.publicKey !== identity.publicKey) {
    throw new ClientError("The device saved in this browser no longer matches the device this tab loaded. Its participant ID or encryption key changed. Chat is paused to avoid using the wrong identity.");
  }
}

function historyKey(chatId, entryId) {
  return `${HISTORY_PREFIX}${identity.publicId}:${chatId}:${entryId}`;
}

async function putDatabaseValue(key, value, removeKey = null, allowed = null) {
  const database = await openDatabase();
  if (allowed && !allowed()) { database.close(); return false; }
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    if (removeKey) {
      // Atomic handoff: no observable child exists while its parent can recreate it.
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result === undefined) store.put(value, key);
        store.delete(removeKey);
      };
    } else store.put(value, key);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onabort = transaction.onerror = () => {
      database.close();
      reject(storageFailure(transaction.error, "The browser could not save local chat history. The message has not been confirmed as saved."));
    };
  });
}

async function observePeerKey(peer) {
  const fingerprint = await SidewordProtocol.publicKeyFingerprint(peer.public_key);
  if (peer.public_id === identity.publicId) {
    const ownFingerprint = await SidewordProtocol.publicKeyFingerprint(identity.publicKey);
    return { ...peer, local_fingerprint: ownFingerprint, key_changed: ownFingerprint !== fingerprint };
  }
  const key = `peer:${identity.publicKey}:${peer.public_id}`;
  const database = await openDatabase();
  const pinned = await new Promise((resolve, reject) => {
    // Atomic read/check/insert: another tab must not overwrite a first-use pin.
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    let value;
    request.onsuccess = () => {
      value = request.result;
      if (value === undefined) {
        value = fingerprint;
        store.put(value, key);
      }
    };
    transaction.oncomplete = () => { database.close(); resolve(value); };
    transaction.onabort = transaction.onerror = () => {
      database.close();
      reject(storageFailure(transaction.error, "The browser could not save a participant's key fingerprint. Messages are blocked because key changes cannot be checked safely."));
    };
  });
  return { ...peer, local_fingerprint: fingerprint, key_changed: pinned !== fingerprint };
}

async function assertTrustedPeer(peer) {
  if ((await observePeerKey(peer)).key_changed) {
    throw new ClientError("A participant's encryption key changed and no longer matches the fingerprint saved on this device. Sending and decryption are blocked. Keep this device's history.");
  }
}

async function readHistoryRecords(recordPrefix = null) {
  if (!identity?.publicId) return [];
  const prefix = recordPrefix || `${HISTORY_PREFIX}${identity.publicId}:`;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const records = [];
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
        records.push({ key: cursor.key, value: cursor.value });
      }
      cursor.continue();
    };
    request.onerror = () => reject(storageFailure(request.error, "The browser could not read saved chat history or pending messages."));
    transaction.oncomplete = () => {
      database.close();
      resolve(records);
    };
  });
}

// Local records are AES-GCM encrypted with the device storage key; the record key is the AAD.
async function sealLocalRecord(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(key) },
    identity.storageKey,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv, ciphertext };
}

async function openLocalRecord(key, record) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: record.iv, additionalData: encoder.encode(key) },
    identity.storageKey,
    record.ciphertext,
  );
  return JSON.parse(decoder.decode(plaintext));
}

async function persistHistoryEntry(chatId, entry, allowed = null) {
  if (!identity?.storageKey || !identity.publicId || !entry.id) {
    throw new ClientError("Local history storage is unavailable: this device's history key or identity is missing. Message retained for retry.");
  }
  const key = historyKey(chatId, entry.id);
  return putDatabaseValue(key, await sealLocalRecord(key, entry), null, allowed);
}

async function loadStoredHistory() {
  if (!identity?.storageKey || !identity.publicId) return;
  if (!messagesByChat.size) {
    loadedHistoryKeys.clear(); receivedMedia.clear(); receivedPreviews.clear(); reactionsByChat.clear(); revealedImages.clear();
  }
  const records = (await readHistoryRecords()).filter(record => !loadedHistoryKeys.has(record.key));
  // Decrypt in parallel, then append without per-record renders: one layout for the whole load.
  const decrypted = await Promise.all(records.map(async record => {
    try {
      const entry = await openLocalRecord(record.key, record.value);
      if (entry.attachment) SidewordProtocol.validatePayload(entry.attachment);
      return { record, chatId: Number(record.key.split(":")[2]), entry };
    } catch {
      return null; // Ignore corrupted local records; authenticated decryption prevents use.
    }
  }));
  let selectedChanged = false;
  for (const item of decrypted) {
    if (!item || loadedHistoryKeys.has(item.record.key)) continue;
    try {
      await appendMessage(item.chatId, item.entry, false, false);
      loadedHistoryKeys.add(item.record.key);
      selectedChanged ||= item.chatId === selectedChatId;
    } catch { /* Keep loading other records. */ }
  }
  for (const entries of messagesByChat.values()) {
    entries.sort(compareHistoryEntries);
  }
  if (selectedChanged) renderMessages();
}

function showToast(message, isError = false) {
  const target = isError ? elements.error : elements.status;
  const other = isError ? elements.status : elements.error;
  other.hidden = true;
  target.textContent = message;
  target.hidden = false;
  // Keep the same announcement visible when a modal makes the workspace inert.
  const dialogPrefix = elements.deviceDialog.open ? "device" : elements.detailsDialog.open ? "details" : null;
  const dialogTarget = dialogPrefix ? document.querySelector(`#${dialogPrefix}-${isError ? "error" : "status"}`) : null;
  if (dialogTarget) {
    document.querySelector(`#${dialogPrefix}-${isError ? "status" : "error"}`).hidden = true;
    dialogTarget.textContent = message;
    dialogTarget.hidden = false;
  }
  window.setTimeout(() => {
    target.hidden = true;
    if (dialogTarget) dialogTarget.hidden = true;
  }, isError ? 7000 : 3500);
}

function errorMessage(error) {
  if (error instanceof ClientError || error instanceof SidewordProtocol.ProtocolError) {
    return error.message;
  }
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "The browser has no space available for saved chat data. Device data has not been reset.";
  }
  if (error instanceof DOMException && error.name === "SecurityError") {
    return "The browser blocked access to local storage or encryption features.";
  }
  if (error instanceof DOMException && error.name === "NotSupportedError") {
    return "This browser does not support the P-256 encryption required by this client.";
  }
  if (error instanceof DOMException && error.name === "OperationError") {
    return "The browser could not encrypt or decrypt this data with the available keys.";
  }
  return "An unexpected client error prevented this operation.";
}

function requestError(status, detail, context = "Chat request failed") {
  const explanations = {
    "link not found": "This invite does not exist on this service.",
    "link expired": "This invite has expired.",
    "link revoked": "The administrator disabled this invite.",
    "conversation closed": "This conversation is closed. Your saved history and pending messages are kept; other conversations remain available.",
    "room sealed; reconnect with your saved session": "This room is full or closed to new devices. Joining again cannot recover an existing participant slot.",
    "This room has an invalid P-256 participant key. Create a new invite.": "This room contains an invalid participant encryption key and cannot accept devices.",
    "The room phrase or password is incorrect.": "The room password does not match, or a required password was left empty.",
    "Too many failed attempts. Try again later.": "Password checks for this room are temporarily blocked after too many failed attempts.",
    "public_key mismatch with existing session": "Your saved login belongs to a different encryption key than this device is using.",
    "public_key mismatch with existing participant": "The saved room participant uses a different encryption key than this device.",
    "This device has joined. Use its saved session or resume credential.": "This device already claimed a room slot, but its saved login or recovery credential is missing.",
    "personal chat has no peer yet": "The other participant has not joined this room yet.",
    "message identity already has a different payload": "This message ID was already used for different encrypted data. The new upload was rejected.",
    "message has no retry record; verify delivery": "The service cannot safely retry this message because its delivery record is missing.",
    "credential already rotated; use saved refresh state": "The saved login recovery credential is older than the server's current credential.",
  };
  const defaults = {
    400: "The service rejected the request because its data does not match the chat state.",
    401: "The service rejected the saved login because it is invalid, expired, or disabled.",
    403: "The service refused permission for this request.",
    404: "The requested room or service endpoint does not exist.",
    409: "The request conflicts with the device, room, or message state saved by the service.",
    410: "This invite, room, or client operation is no longer available.",
    413: "The request is larger than the service allows.",
    422: "The service rejected one or more request fields as invalid.",
    429: "The service temporarily blocked this request because a rate or capacity limit was reached.",
  };
  let explanation = typeof detail === "string" && Object.hasOwn(explanations, detail)
    ? explanations[detail]
    : defaults[status] || (status >= 500
      ? "The chat service could not complete the request because of a server error."
      : "The chat service rejected this request.");
  if (status === 422 && Array.isArray(detail) && detail.some(item => (
    Array.isArray(item?.loc) && item.loc.length === 2
    && item.loc[0] === "body" && item.loc[1] === "public_key"
  ))) {
    explanation = "The service rejected this device's public encryption key. The client and server may use different test encryption formats.";
  }
  return new ClientError(`${context} (HTTP ${status}). ${explanation}`);
}

async function fetchClient(path, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(path, { ...options, signal: controller.signal });
    } catch {
      throw new ClientError("No response was received from the chat service. The network connection failed or the service is unavailable; the server may already have processed the request.");
    }
    // Reject an invalid login promptly even if a proxy's error body stalls.
    if (response.status === 401) return { ok: false, status: 401 };
    let body;
    try {
      if (response.ok && path.endsWith("/media/read")) {
        const reader = response.body.getReader();
        const bytes = new Uint8Array(SidewordProtocol.MAX_WIRE_CHARS + 2048);
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.byteLength > bytes.length) {
              await reader.cancel(); throw new Error("Media response too large");
            }
            bytes.set(value, size);
            size += value.byteLength;
          }
        } finally { reader.releaseLock(); }
        body = JSON.parse(decoder.decode(bytes.subarray(0, size)));
      } else body = await response.json();
    } catch {
      if (response.ok) {
        throw new ClientError("The chat service returned a response this client could not read; the server may already have processed the request.");
      }
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    window.clearTimeout(timeout);
    controller.abort();
  }
}

class SessionExpiredError extends ClientError {}

async function invalidateSession(reason = "Session expired") {
  mediaPreviews?.clear();
  releaseAllLinkPreviews();
  resetLinkPreviewRequests();
  if (elements.imageViewer.open) elements.imageViewer.close();
  stopMediaTransfers();
  if (!identity) return;
  clearPresence();
  messageProfileReady = false;
  refreshVisibleReads();
  if (identity.token) identity.suspendedToken = identity.token;
  identity.token = null;
  accessDeadline = null;
  checkAccessExpiry();
  await writeIdentity(identity, true);
  chats = [];
  selectedChatId = null;
  disconnectSocket();
  updateIdentityUi();
  elements.inviteToken.focus();
  throw new SessionExpiredError(`${reason}. Chat is paused; your local keys and saved messages are kept.`);
}

function randomCredential() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function deviceLock(name, action) {
  if (!globalThis.navigator?.locks) {
    throw new ClientError("This browser cannot coordinate saved logins and message retries safely across tabs because Web Locks is unavailable.");
  }
  return navigator.locks.request(`sideword:${name}`, action);
}

async function ensureFreshSession(force = false) {
  if (!identity?.token) return;
  const previousToken = identity.token;
  await deviceLock("session", async () => {
    const stored = await readIdentity();
    if (!stored) {
      throw new DeviceStorageError("Local device data is missing: the browser no longer has the saved device record this tab loaded. Chat is paused to avoid losing access to its encryption key.");
    }
    if (stored.publicId !== identity.publicId || stored.publicKey !== identity.publicKey) {
      throw new ClientError("The device saved in this browser no longer matches the device this tab loaded. Its participant ID or encryption key changed. Chat is paused to avoid using the wrong identity.");
    }
    identity = stored;
    if ((!force || identity.token !== previousToken) && identity.refreshCredential
        && Date.now() < identity.tokenExpiresAt - 60000) return;
    if (!identity.refreshCredential) {
      await invalidateSession("This saved login is missing its refresh credential; reopen its invite to recover access");
    }
    identity.pendingRefreshCredential ||= randomCredential();
    await writeIdentity(identity, true); // Keep the proposed rotation if the response/save is lost.
    const response = await fetchClient("/api/v1/sessions/refresh", {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: identity.refreshCredential, next_credential: identity.pendingRefreshCredential,
      }),
    });
    if (!response.ok) {
      if (response.status === 401) await invalidateSession("The server rejected the saved login (HTTP 401); it has expired or was disabled");
      throw requestError(response.status, undefined, "Could not renew the saved login");
    }
    const result = response.body;
    identity.token = result.token;
    identity.sessionId = result.session_id;
    identity.tokenExpiresAt = Date.parse(result.access_expires_at);
    identity.sessionExpiresAt = Date.parse(result.session_expires_at);
    identity.refreshCredential = identity.pendingRefreshCredential;
    delete identity.pendingRefreshCredential;
    await writeIdentity(identity, true);
    disconnectSocket();
    connectSocket();
  });
}

async function api(path, options = {}) {
  const activation = path.includes("/links/");
  if (!activation && identity?.token) await ensureFreshSession();
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (identity?.token) {
    headers.set("Authorization", `Bearer ${identity.token}`);
  }
  const response = await fetchClient(path, { ...options, headers, cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401) {
      await invalidateSession("The server rejected the saved login (HTTP 401); it has expired or was disabled");
    }
    throw requestError(response.status, response.body?.detail, activation ? "Could not join the room" : "Chat request failed");
  }
  return response.body;
}

async function encryptForRecipient(plaintext, chatId, messageId, recipient) {
  await assertTrustedPeer(recipient);
  return SidewordProtocol.encryptForRecipient(identity, plaintext, chatId, messageId, recipient);
}

async function decryptMessage(message) {
  const chat = chats.find(candidate => candidate.id === message.chat_id);
  const sender = chat?.participants.find(peer => peer.public_id === message.sender_public_id);
  if (!sender) throw new ClientError("The message sender is missing from this room's participant list, so their encryption key is unavailable.");
  await assertTrustedPeer(sender);
  return SidewordProtocol.decryptMessage(identity, message, sender);
}

async function appendMessage(chatId, entry, persist = true, render = true) {
  const entries = messagesByChat.get(chatId) || [];
  if (entry.id && entries.some((candidate) => candidate.id === entry.id)) {
    return Promise.resolve();
  }
  entry.createdAt ||= Date.now();
  if (persist && entry.id) await persistHistoryEntry(chatId, entry);
  if (persist && entry.id && identity?.publicId) loadedHistoryKeys.add(historyKey(chatId, entry.id));
  entries.push(entry);
  entries.sort(compareHistoryEntries);
  messagesByChat.set(chatId, entries);
  indexMessageMetadata(chatId, entry);
  if (render && selectedChatId === chatId) renderMessages();
}

function serverTimestamp(value) {
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`;
  return Date.parse(utc) || Date.now();
}

function messageKey(message) {
  return `incoming:${JSON.stringify([message.chat_id, message.sender_public_id, message.client_message_id])}`;
}

function metadataKey(chatId, messageId) {
  return JSON.stringify([chatId, messageId]);
}

async function messageEventId(kind, fields) {
  // Keep recipient metadata inside encrypted values, not plaintext database keys.
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(fields)));
  return `${kind}:${bytesToBase64(new Uint8Array(digest))}`;
}

function metadataFor(chatId, messageId) {
  const key = metadataKey(chatId, messageId);
  if (!messageMetadata.has(key)) messageMetadata.set(key, { receipts: new Map(), acceptance: null });
  return messageMetadata.get(key);
}

function outgoingMessageId(entry) {
  return entry.clientMessageId;
}

function hiddenMessageEntry(entry) {
  return ["receipt", "acceptance", "viewed", "read_ack", "delivery_ack", "delivery_ref", "send_failed", "delivery_state", "media_ready", "link_preview", "reaction"].includes(entry.kind);
}

function indexMessageMetadata(chatId, entry) {
  if (entry.kind === "reaction") { indexReaction(chatId, entry); return; }
  if (entry.kind === "link_preview") {
    // First preview wins: a message's card cannot be replaced later.
    if (!receivedPreviews.has(entry.target)) receivedPreviews.set(entry.target, entry.preview);
    const original = messagesByChat.get(chatId)?.find(message => message.id === entry.target);
    if (original && !original.preview) original.preview = receivedPreviews.get(entry.target);
    return;
  }
  if (entry.id && !entry.preview && receivedPreviews.has(entry.id)) entry.preview = receivedPreviews.get(entry.id);
  if (entry.kind === "media_ready") {
    receivedMedia.set(entry.target, entry);
    const original = messagesByChat.get(chatId)?.find(message => message.id === entry.target);
    if (original) original.attachment = entry.attachment;
    queueDelivery(entry.delivery);
    return;
  }
  if (entry.id && receivedMedia.has(entry.id)) entry.attachment = receivedMedia.get(entry.id).attachment;
  if (entry.kind === "receipt" && entry.readerPublicId && entry.clientMessageId) {
    const metadata = metadataFor(chatId, entry.clientMessageId);
    metadata.receipts.set(entry.id, entry);
    seenReceiptIds.add(entry.id);
  } else if (entry.kind === "acceptance") {
    const metadata = metadataFor(chatId, entry.clientMessageId);
    if (!metadata.acceptance || Object.keys(entry.deliveries || {}).length
        >= Object.keys(metadata.acceptance.deliveries || {}).length) metadata.acceptance = entry;
  } else if (entry.kind === "delivery_state") {
    const metadata = metadataFor(chatId, entry.clientMessageId);
    metadata.unavailable ||= new Map();
    metadata.unavailable.set(entry.recipient, entry);
  } else if (entry.kind === "send_failed") {
    outgoingAttempts.set(metadataKey(chatId, entry.clientMessageId), "failed");
  } else if (entry.kind === "delivery_ack") {
    acknowledgedDeliveries.add(entry.delivery.delivery_id);
    pendingDeliveries.delete(entry.delivery.delivery_id);
  } else if (entry.kind === "read_ack") {
    acknowledgedReads.add(entry.delivery.delivery_id);
    pendingReadsByChat.get(chatId)?.delete(entry.delivery.delivery_id);
  } else if (entry.kind === "viewed") {
    queueRead(entry.delivery);
  }
  if (entry.kind === "theirs" || entry.kind === "delivery_ref") {
    if (entry.kind === "theirs" && entry.id) seenMessageIds.add(entry.id);
    if (entry.delivery) {
      const key = entry.kind === "theirs" ? entry.id : entry.messageKey;
      const refs = deliveryReferences.get(key) || new Map();
      refs.set(entry.delivery.delivery_id, entry.delivery);
      deliveryReferences.set(key, refs);
      queueDelivery(entry.delivery);
    }
  }
}

function receiptTime(value) {
  if (!value) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

function outgoingStatus(chatId, entry) {
  const messageId = outgoingMessageId(entry);
  const metadata = metadataFor(chatId, messageId);
  const acceptance = metadata.acceptance;
  const recipientIds = acceptance?.recipients || entry.recipients;
  const recipientsKnown = Array.isArray(recipientIds) && recipientIds.length > 0
    && new Set(recipientIds).size === recipientIds.length;
  const ids = recipientsKnown ? recipientIds : [...new Set(
    [...metadata.receipts.values()].map(receipt => receipt.readerPublicId))];
  const states = ids.map(publicId => ({ publicId, delivered: false, read: false,
    deliveredAt: null, readAt: null }));
  for (const receipt of metadata.receipts.values()) {
    const state = states.find(peer => peer.publicId === receipt.readerPublicId);
    if (!state) continue;
    const expected = acceptance?.deliveries?.[state.publicId];
    if (expected && receipt.messageDeliveryId !== expected) continue;
    const time = Object.hasOwn(receipt, "confirmedAt") ? receipt.confirmedAt : historyTimestamp(receipt);
    state.delivered = true;
    if (receipt.receiptKind === "read") {
      state.read = true;
      if (time !== null) state.readAt = state.readAt === null ? time : Math.min(state.readAt, time);
    } else {
      if (time !== null) state.deliveredAt = state.deliveredAt === null ? time : Math.min(state.deliveredAt, time);
    }
  }
  for (const state of states) {
    const terminal = metadata.unavailable?.get(state.publicId);
    const expected = acceptance?.deliveries?.[state.publicId];
    if (!state.delivered && terminal && expected === terminal.deliveryId) state.failure = terminal.state;
  }
  const failures = states.filter(peer => peer.failure);
  const accepted = Boolean(acceptance || states.some(peer => peer.delivered));
  const attempt = outgoingAttempts.get(metadataKey(chatId, messageId));
  const readCount = states.filter(peer => peer.read).length;
  const allRead = recipientsKnown && readCount === states.length;
  const status = !accepted ? (attempt || "pending")
    : failures.length ? (failures.some(peer => peer.failure === "unavailable") ? "unavailable" : "expired")
    : readCount > 0 ? "read"
    : recipientsKnown && states.every(peer => peer.delivered) ? "delivered" : "sent";
  return { status, states, recipientsKnown, messageId, accepted, readCount, allRead,
    timestamp: acceptance?.createdAt || historyTimestamp(entry) };
}

function statusLabel(status) {
  return ({ sending: "Sending", pending: "Pending retry", failed: "Failed", sent: "Sent",
    delivered: "Delivered", read: "Read", expired: "Delivery expired", unavailable: "Delivery unavailable" })[status] || "Status unknown";
}

function messageStatusLabel(state) {
  if (state.status !== "read" || (state.recipientsKnown && state.states.length === 1)) {
    return statusLabel(state.status);
  }
  return state.recipientsKnown ? `Read by ${state.readCount} of ${state.states.length} recipients`
    : `Read by ${state.readCount} confirmed recipient${state.readCount === 1 ? "" : "s"}`;
}

function enqueueIncoming(action) {
  const result = inboundQueue.then(action);
  inboundQueue = result.catch(() => {});
  return result;
}

function historyTimestamp(entry) {
  if (typeof entry.createdAt === "number") return entry.createdAt;
  const parsed = Date.parse(entry.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareHistoryEntries(left, right) {
  const timestampDifference = historyTimestamp(left) - historyTimestamp(right);
  if (timestampDifference) return timestampDifference;
  return String(left.id || "").localeCompare(String(right.id || ""));
}

function participantLabel(chatId, publicId, includePublicId = true) {
  const chat = chats.find((candidate) => candidate.id === chatId);
  const participant = chat?.participants.find((peer) => peer.public_id === publicId);
  if (!participant) return null;
  const name = participant.display_name?.trim();
  return name ? (includePublicId ? `${name} (${publicId})` : name) : publicId;
}

function messageMeta(chatId, entry) {
  if (entry.kind === "mine") {
    const label = participantLabel(chatId, entry.senderPublicId || identity?.publicId, false);
    return label ? `Sent by ${label}` : entry.meta;
  }
  if (entry.kind !== "theirs") return entry.meta;
  const label = participantLabel(chatId, entry.senderPublicId);
  return label ? `From ${label}` : entry.meta;
}

function readableNow(node) {
  if (chats.find(chat => chat.id === selectedChatId)?.closed_at
      || !messageProfileReady || !conversationVisible() || document.visibilityState !== "visible"
      || typeof document.hasFocus !== "function" || !document.hasFocus()
      || elements.detailsDialog.open || elements.deviceDialog.open || elements.messageDetails.open
      || elements.imageViewer.open
      || !visibleMessageNodes.has(node) || renderedMessages.get(node.messageEntry?.id) !== node) return false;
  const box = node.messageBubble.getBoundingClientRect();
  const list = elements.messageList.getBoundingClientRect();
  const top = Math.max(box.top, list.top, 0);
  const bottom = Math.min(box.bottom, list.bottom, window.innerHeight);
  const width = Math.min(box.right, list.right, window.innerWidth) - Math.max(box.left, list.left, 0);
  return box.height > 0 && width >= box.width / 2
    && bottom - top >= Math.min(box.height / 2, 48);
}

const messageVisibilityObserver = typeof IntersectionObserver === "function"
  ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleMessageNodes.add(entry.target);
      else visibleMessageNodes.delete(entry.target);
    }
    refreshVisibleReads();
    scheduleVisiblePreviews();
  }, { root: elements.messageList, threshold: [0, 0.5, 1] }) : null;

function refreshVisibleReads() {
  for (const [node, timer] of viewTimers) {
    if (!readableNow(node)) { window.clearTimeout(timer); viewTimers.delete(node); }
  }
  for (const node of visibleMessageNodes) {
    if (!readableNow(node) || viewTimers.has(node)) continue;
    const refs = [...(deliveryReferences.get(node.messageEntry.id)?.values() || [])];
    if (!refs.some(ref => !acknowledgedReads.has(ref.delivery_id)
        && !pendingReadsByChat.get(ref.chat_id)?.has(ref.delivery_id))) continue;
    viewTimers.set(node, window.setTimeout(() => {
      viewTimers.delete(node);
      if (!readableNow(node)) return;
      void enqueueIncoming(async () => {
        if (!readableNow(node)) return;
        for (const reference of refs) {
          // Save viewing evidence before queuing a retryable read confirmation.
          await appendMessage(reference.chat_id, { id: `viewed:${reference.delivery_id}`,
            kind: "viewed", delivery: reference });
        }
        await flushAcknowledgements();
      }).catch(error => showToast(errorMessage(error), true));
    }, 750));
  }
}

function displayTimestamp(value, full = false, formatters = null) {
  if (!Number.isFinite(value) || value <= 0) return "Time unavailable";
  let formatter = formatters?.get(full);
  if (!formatter) {
    const options = full ? { dateStyle: "short", timeStyle: "medium" }
      : { hour: "2-digit", minute: "2-digit" };
    formatter = new Intl.DateTimeFormat(undefined, options);
    formatters?.set(full, formatter);
  }
  return formatter.format(new Date(value));
}

function messageSenderId(chatId, entry) {
  if (entry.senderPublicId) return entry.senderPublicId;
  if (entry.kind === "mine") return identity?.publicId || null;
  return null;
}

function messageSenderName(chatId, entry) {
  const publicId = messageSenderId(chatId, entry);
  const peer = chats.find(chat => chat.id === chatId)?.participants
    .find(peer => peer.public_id === publicId);
  if (peer) return peer.display_name?.trim() || (entry.kind === "mine" ? "You" : "Participant");
  // Preserve saved labels while keeping routing IDs out of the timeline.
  let saved = entry.meta?.replace(/^(?:From |Sent by )/, "").trim();
  if (publicId && saved?.endsWith(` (${publicId})`)) saved = saved.slice(0, -(publicId.length + 3));
  if (saved && saved !== publicId && /^(?:From |Sent by )/.test(entry.meta)) return saved;
  return entry.kind === "mine" ? "You" : "Participant";
}

function messageDisplayTime(chatId, entry) {
  if (entry.kind !== "mine") return historyTimestamp(entry);
  const acceptance = metadataFor(chatId, outgoingMessageId(entry)).acceptance;
  return acceptance?.createdAt || historyTimestamp(entry);
}

function groupedWithPrevious(chatId, entry, previous) {
  if (!previous || !["mine", "theirs"].includes(entry.kind) || entry.kind !== previous.kind) return false;
  const sender = messageSenderId(chatId, entry);
  const elapsed = messageDisplayTime(chatId, entry) - messageDisplayTime(chatId, previous);
  return Boolean(sender && sender === messageSenderId(chatId, previous)
    && elapsed >= 0 && elapsed <= 5 * 60 * 1000);
}

function deliveryIcon(status) {
  const kind = status === "delivered" || status === "read" ? "double-check"
    : status === "sent" ? "check" : status === "sending" ? "clock" : "warning";
  const paths = {
    check: ["M6 9l5 5L19 3"],
    "double-check": ["M2 10l5 5L18 4", "M13 14l2 2 7-7"],
    clock: ["M12 3a6 6 0 1 0 0 12a6 6 0 1 0 0-12", "M12 5v4l3 2"],
    warning: ["M12 2l10 14H2Z", "M12 7v4", "M12 13h.01"],
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.dataset.icon = kind;
  for (const definition of paths[kind]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", definition);
    svg.append(path);
  }
  return svg;
}

function updateMessageFooter(node, chatId, entry) {
  if (entry.kind !== "mine") return;
  let footer = node.messageFooter;
  if (!footer) {
    footer = document.createElement("span");
    footer.className = "message-footer";
    footer.indicator = document.createElement("button");
    footer.indicator.type = "button";
    footer.indicator.className = "message-status";
    footer.indicator.addEventListener("click", event => {
      event.stopPropagation(); showMessageDetails(chatId, entry, footer.indicator);
    });
    footer.append(footer.indicator);
    node.messageFooter = footer;
    node.messageBubble.append(footer);
  }
  const state = outgoingStatus(chatId, entry);
  const status = entry.attachment ? messageStatusLabel(state).replace(/^Read/, "Card viewed") : messageStatusLabel(state);
  const label = `${status}. Open message details`;
  footer.indicator.className = `message-status status-${state.status}`;
  footer.indicator.setAttribute("aria-label", label);
  footer.indicator.title = label;
  const icon = deliveryIcon(state.status);
  if (footer.indicator.dataset.icon !== icon.dataset.icon) {
    footer.indicator.replaceChildren(icon);
    footer.indicator.dataset.icon = icon.dataset.icon;
  }
}

// Reactions travel as encrypted `reaction` messages to every other participant. Each names its
// target by author public ID and client message ID; the local key adds this chat's ID.
function reactionTargetKey(chatId, targetAuthor, targetMessageId) {
  return targetAuthor === identity?.publicId ? `outgoing:${targetMessageId}`
    : messageKey({ chat_id: chatId, sender_public_id: targetAuthor, client_message_id: targetMessageId });
}

function reactionTarget(entry) {
  if (entry.kind === "mine" && entry.clientMessageId && identity?.publicId) {
    return { author: identity.publicId, messageId: entry.clientMessageId };
  }
  if (entry.kind === "theirs" && entry.senderPublicId && entry.delivery?.client_message_id) {
    return { author: entry.senderPublicId, messageId: entry.delivery.client_message_id };
  }
  return null;
}

// The highest revision wins; equal revisions resolve by emoji so every device converges.
function supersedesReaction(candidate, current) {
  if (!current) return true;
  if (candidate.rev !== current.rev) return candidate.rev > current.rev;
  return (candidate.emoji || "") > (current.emoji || "");
}

function currentReaction(chatId, target, reactorPublicId) {
  return reactionsByChat.get(chatId)?.get(target)?.get(reactorPublicId) || null;
}

// Targets that have not arrived yet keep their state and show once the message appears.
function indexReaction(chatId, entry) {
  if (typeof entry.target !== "string" || typeof entry.reactorPublicId !== "string"
      || !Number.isSafeInteger(entry.rev) || entry.rev < 1
      || !(entry.emoji === null || SidewordProtocol.REACTION_EMOJI.includes(entry.emoji))) return;
  if (!supersedesReaction(entry, currentReaction(chatId, entry.target, entry.reactorPublicId))) return;
  let targets = reactionsByChat.get(chatId);
  if (!targets) reactionsByChat.set(chatId, targets = new Map());
  let reactors = targets.get(entry.target);
  if (!reactors) targets.set(entry.target, reactors = new Map());
  reactors.set(entry.reactorPublicId, { emoji: entry.emoji, rev: entry.rev, messageId: entry.clientMessageId || null });
}

function reactionsAvailable(chatId) {
  const chat = chats.find(candidate => candidate.id === chatId);
  return Boolean(chat && !chat.closed_at && identity?.publicId
    && !chat.participants.some(peer => peer.key_changed)
    && chat.participants.some(peer => peer.public_id !== identity.publicId));
}

// Choosing the current emoji removes it; another replaces it. Operations run one at a time,
// so each takes the revision after the previous one, which is durably queued first.
function toggleReaction(chatId, entry, emoji) {
  reactionQueue = reactionQueue.then(() => sendReaction(chatId, entry, emoji))
    .catch(error => showToast(errorMessage(error), true));
  return reactionQueue;
}

async function sendReaction(chatId, entry, emoji) {
  const target = reactionTarget(entry);
  if (!target || !reactionsAvailable(chatId) || !SidewordProtocol.REACTION_EMOJI.includes(emoji)) return;
  const chat = chats.find(candidate => candidate.id === chatId);
  const recipients = chat.participants.filter(peer => peer.public_id !== identity.publicId);
  if (recipients.length > 100) throw new ClientError("This conversation exceeds the recipient limit.");
  for (const recipient of recipients) await assertTrustedPeer(recipient);
  const current = currentReaction(chatId, reactionTargetKey(chatId, target.author, target.messageId), identity.publicId);
  const payload = SidewordProtocol.reactionPayload(target.author, target.messageId,
    current?.emoji === emoji ? null : emoji, (current?.rev || 0) + 1);
  await queueEncryptedMessage(chat, recipients, crypto.randomUUID(), payload);
  try { await flushOutbox(); }
  finally { await renderOutbox(); }
}

// Tapping message controls keeps the composer focused so the mobile keyboard stays open.
function keepComposerFocus(event) {
  if (document.activeElement === elements.messageInput) event.preventDefault();
}

function reactionIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "1.5", "stroke-linecap": "round", "aria-hidden": "true", focusable: "false" })) {
    icon.setAttribute(name, value);
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M20.5 11.5a8.5 8.5 0 1 1-8-8.5 M8.5 14a4.5 4.5 0 0 0 7 0 M9 9.5h.01 M15 9.5h.01 M19 2v6 M16 5h6");
  icon.append(path);
  return icon;
}

const REACTION_ANIMATION_MS = 160;

// Chips are reused per emoji, so updates change counts in place and keep focus and hover.
function createReactionChip(node, emoji) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "reaction-chip";
  const glyph = document.createElement("span");
  glyph.className = "reaction-emoji";
  glyph.textContent = emoji;
  chip.reactionCount = document.createElement("span");
  chip.reactionCount.className = "reaction-count";
  chip.append(glyph, chip.reactionCount);
  chip.addEventListener("mousedown", keepComposerFocus);
  chip.addEventListener("click", event => {
    event.stopPropagation();
    void toggleReaction(node.reactionChatId, node.messageEntry, emoji);
  });
  return chip;
}

function updateReactionChip(chip, emoji, group, available) {
  const names = group.names.slice(0, MAX_REACTION_NAMES).join(", ")
    + (group.names.length > MAX_REACTION_NAMES ? ` and ${group.names.length - MAX_REACTION_NAMES} more` : "");
  const label = `${emoji} ${group.names.length}: ${names}${group.unsent ? ". Your reaction is not sent yet" : ""}`;
  chip.className = group.unsent ? "reaction-chip reaction-unsent" : "reaction-chip";
  chip.disabled = !available;
  chip.setAttribute("aria-pressed", String(group.mine));
  chip.setAttribute("aria-label", label);
  chip.title = label;
  if (chip.reactionCount.textContent !== String(group.names.length)) chip.reactionCount.textContent = String(group.names.length);
}

// Reactions share the bubble's last line with the delivery status, so they never need their own row.
function updateReactions(node, chatId, entry) {
  const target = reactionTarget(entry);
  if (!target) return;
  node.reactionChatId = chatId;
  const firstRender = !node.reactionTrigger;
  if (firstRender) {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "reaction-trigger";
    trigger.title = "React";
    trigger.setAttribute("aria-label", "Add reaction");
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    trigger.append(reactionIcon());
    trigger.addEventListener("mousedown", keepComposerFocus);
    trigger.addEventListener("click", event => {
      event.stopPropagation();
      toggleReactionPicker(node, event.detail === 0);
    });
    const row = document.createElement("div");
    row.className = "message-reactions";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Reactions");
    row.hidden = true;
    node.messageBubble.insertBefore(row, node.messageFooter || null);
    node.messageBubble.append(trigger);
    node.reactionTrigger = trigger;
    node.reactionRow = row;
    node.reactionChips = new Map();
    node.reactionLayout = false;
  }
  const chat = chats.find(candidate => candidate.id === chatId);
  const groups = new Map();
  for (const [reactor, state] of reactionsByChat.get(chatId)?.get(reactionTargetKey(chatId, target.author, target.messageId)) || []) {
    if (!state.emoji) continue;
    const group = groups.get(state.emoji) || { names: [], mine: false, unsent: false };
    if (reactor === identity?.publicId) {
      group.mine = true;
      const metadataId = metadataKey(chatId, state.messageId);
      group.unsent = outgoingAttempts.get(metadataId) === "failed" && !messageMetadata.get(metadataId)?.acceptance;
      group.names.unshift("You");
    } else {
      const peer = chat?.participants.find(candidate => candidate.public_id === reactor);
      group.names.push(peer?.display_name?.trim() || "Participant");
    }
    groups.set(state.emoji, group);
  }
  const available = reactionsAvailable(chatId);
  const chips = SidewordProtocol.REACTION_EMOJI.filter(emoji => groups.has(emoji))
    .map(emoji => [emoji, groups.get(emoji)]);
  const signature = JSON.stringify([available, chips]);
  if (node.reactionSignature === signature) return;
  node.reactionSignature = signature;
  node.reactionTrigger.disabled = !available;
  if (!available && reactionPicker?.host === node) closeReactionPicker();
  const membership = chips.map(([emoji]) => emoji).join();
  const resized = membership !== node.reactionMembership;
  node.reactionMembership = membership;
  const change = () => applyReactionChips(node, chips, available);
  // Only added or removed chips can move the layout; count and label updates happen in place.
  if (firstRender || !resized) change();
  else animateReactionChange(node, change);
}

// Returns chips that were added, for their entrance animation.
function applyReactionChips(node, chips, available) {
  const row = node.reactionRow;
  const added = [];
  const wanted = new Set(chips.map(([emoji]) => emoji));
  for (const [emoji, chip] of node.reactionChips) {
    if (wanted.has(emoji)) continue;
    // Keep keyboard users on the message when the focused chip disappears.
    if (document.activeElement === chip) node.reactionTrigger.focus({ preventScroll: true });
    chip.remove();
    node.reactionChips.delete(emoji);
  }
  chips.forEach(([emoji, group], index) => {
    let chip = node.reactionChips.get(emoji);
    if (!chip) {
      chip = createReactionChip(node, emoji);
      node.reactionChips.set(emoji, chip);
      added.push(chip);
    }
    updateReactionChip(chip, emoji, group, available);
    if (row.children[index] !== chip) row.insertBefore(chip, row.children[index] || null);
  });
  if (row.hidden !== !chips.length) row.hidden = !chips.length;
  updateReactionLayout(node);
  return added;
}

// The bubble eases to its new size and new chips grow in; offscreen or with reduced motion the
// change applies at once without moving the reading position.
function animateReactionChange(node, change) {
  if (reducedMotion() || !messageInView(node)) {
    keepScrollPosition(change);
    return;
  }
  const bubble = node.messageBubble;
  for (const animation of bubble.getAnimations?.() || []) animation.finish();
  const before = bubble.getBoundingClientRect();
  const added = change();
  const after = bubble.getBoundingClientRect();
  const timing = { duration: REACTION_ANIMATION_MS, easing: "cubic-bezier(.2, 0, 0, 1)" };
  if (Math.abs(before.width - after.width) >= 1 || Math.abs(before.height - after.height) >= 1) {
    bubble.animate?.([{ width: `${before.width}px`, height: `${before.height}px`, overflow: "hidden" },
      { width: `${after.width}px`, height: `${after.height}px`, overflow: "hidden" }], timing);
  }
  for (const chip of added) chip.animate?.([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }], timing);
}

function updateReactionLayout(node) {
  const active = !node.reactionRow.hidden;
  if (node.reactionLayout === active) return;
  node.reactionLayout = active;
  node.messageBubble.classList.toggle("has-reactions", active);
}

// One shared floating bar beside the message, outside the bubble, so opening it never resizes cards.
function reactionPickerControl() {
  if (reactionPicker) return reactionPicker;
  const node = document.createElement("div");
  node.className = "reaction-picker";
  node.setAttribute("role", "group");
  node.setAttribute("aria-label", "Choose a reaction");
  node.hidden = true;
  const buttons = SidewordProtocol.REACTION_EMOJI.map((emoji, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reaction-option";
    button.textContent = emoji;
    button.title = REACTION_NAMES[index];
    button.setAttribute("aria-label", REACTION_NAMES[index]);
    button.addEventListener("mousedown", keepComposerFocus);
    button.addEventListener("click", event => {
      event.stopPropagation();
      const host = reactionPicker.host;
      closeReactionPicker(event.detail === 0);
      if (host) void toggleReaction(host.reactionChatId, host.messageEntry, emoji);
    });
    return button;
  });
  node.append(...buttons);
  node.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeReactionPicker(true);
      return;
    }
    // Tab leaves the bar from its trigger, so focus continues in reading order.
    if (event.key === "Tab") { closeReactionPicker(true); return; }
    const index = buttons.indexOf(document.activeElement);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (index < 0 || next === undefined) return;
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length].focus({ preventScroll: true });
  });
  elements.conversation.append(node);
  reactionPicker = { node, buttons, host: null };
  return reactionPicker;
}

function updateReactionPicker(node) {
  const target = reactionTarget(node.messageEntry);
  const own = target && currentReaction(node.reactionChatId,
    reactionTargetKey(node.reactionChatId, target.author, target.messageId), identity?.publicId);
  let current = null;
  reactionPicker.buttons.forEach((button, index) => {
    const pressed = own?.emoji === SidewordProtocol.REACTION_EMOJI[index];
    button.setAttribute("aria-pressed", String(pressed));
    if (pressed) current = button;
  });
  return current;
}

// Beside the trigger, toward the free side of the screen; above or below it when that side
// is too narrow (phones). Closes once its message scrolls out of view.
function positionReactionPicker() {
  const host = reactionPicker?.host;
  if (!host) return;
  const anchor = host.reactionTrigger.getBoundingClientRect();
  const bounds = elements.messageList.getBoundingClientRect();
  if (anchor.bottom < bounds.top || anchor.top > bounds.bottom) { closeReactionPicker(); return; }
  const picker = reactionPicker.node;
  const width = picker.offsetWidth || 0;
  const height = picker.offsetHeight || 0;
  const gap = 6;
  const mine = host.messageEntry.kind === "mine";
  let left = mine ? anchor.left - gap - width : anchor.right + gap;
  let top = anchor.top + anchor.height / 2 - height / 2;
  if (left < bounds.left + gap || left + width > bounds.right - gap) {
    left = mine ? anchor.right - width : anchor.left;
    top = anchor.top - gap - height >= bounds.top ? anchor.top - gap - height : anchor.bottom + gap;
  }
  left = Math.max(bounds.left + gap, Math.min(left, bounds.right - gap - width));
  top = Math.max(bounds.top + gap, Math.min(top, bounds.bottom - gap - height));
  picker.style.left = `${Math.round(left)}px`;
  picker.style.top = `${Math.round(top)}px`;
}

function toggleReactionPicker(node, moveFocus) {
  if (reactionPicker?.host === node) { closeReactionPicker(moveFocus); return; }
  closeReactionPicker();
  if (!reactionsAvailable(node.reactionChatId)) return;
  const picker = reactionPickerControl();
  picker.host = node;
  picker.node.classList.toggle("from-mine", node.messageEntry.kind === "mine");
  picker.node.hidden = false;
  node.reactionTrigger.setAttribute("aria-expanded", "true");
  const current = updateReactionPicker(node);
  positionReactionPicker();
  if (moveFocus) (current || picker.buttons[0]).focus({ preventScroll: true });
}

function closeReactionPicker(restoreFocus = false) {
  const host = reactionPicker?.host;
  if (!host) return;
  reactionPicker.host = null;
  reactionPicker.node.hidden = true;
  host.reactionTrigger.setAttribute("aria-expanded", "false");
  if (restoreFocus && host.isConnected !== false) host.reactionTrigger.focus({ preventScroll: true });
}

document.addEventListener("pointerdown", event => {
  const host = reactionPicker?.host;
  if (!host || reactionPicker.node.contains(event.target) || host.reactionTrigger.contains(event.target)) return;
  closeReactionPicker();
});
function updateMessageHeader(node, chatId, entry, previous, timestampFormatters) {
  if (!node.messageHeader) return;
  const header = node.messageHeader;
  const timestamp = messageDisplayTime(chatId, entry);
  const grouped = groupedWithPrevious(chatId, entry, previous);
  node.className = `message ${entry.kind}${grouped ? " continuation" : ""}`;
  header.sender.textContent = messageSenderName(chatId, entry);
  header.sender.hidden = grouped;
  header.dot.hidden = grouped;
  header.timestamp.textContent = displayTimestamp(timestamp, false, timestampFormatters);
  header.timestamp.title = displayTimestamp(timestamp, true, timestampFormatters);
  if (timestamp > 0) header.timestamp.dateTime = new Date(timestamp).toISOString();
  header.hidden = grouped && Math.floor(timestamp / 60000)
    === Math.floor(messageDisplayTime(chatId, previous) / 60000);
  node.setAttribute("aria-label", `Message from ${header.sender.textContent}`);
  updateMessageFooter(node, chatId, entry);
}

function detailsParticipantLabel(chatId, publicId) {
  const chat = chats.find(chat => chat.id === chatId);
  const peer = chat?.participants.find(peer => peer.public_id === publicId);
  const name = peer?.display_name?.trim();
  if (!name) return publicId;
  const duplicate = chat.participants.some(candidate => candidate.public_id !== publicId
    && candidate.display_name?.trim() === name);
  return duplicate ? `${name} (${publicId})` : name;
}

function refreshMessageDetails() {
  if (!openMessageDetails) return;
  const { chatId, entry } = openMessageDetails;
  const state = outgoingStatus(chatId, entry);
  document.querySelector("#message-details-status").textContent = entry.attachment
    ? messageStatusLabel(state).replace(/^Read/, "Card viewed") : messageStatusLabel(state);
  document.querySelector("#message-details-time").textContent = displayTimestamp(state.timestamp, true);
  const groups = document.querySelector("#message-details-recipients");
  groups.replaceChildren();
  // Each recipient appears once; only "Read by" shows when empty, so lists never contradict.
  const pending = state.states.filter(peer => !peer.delivered && !peer.failure);
  for (const [label, peers, timeField] of [
    ["Read by", state.states.filter(peer => peer.read), "readAt"],
    ["Delivered to", state.states.filter(peer => peer.delivered && !peer.read), "deliveredAt"],
    ["Pending", pending, null],
    ...(["expired", "unavailable"].filter(failure => state.states.some(peer => peer.failure === failure))
      .map(failure => [failure === "expired" ? "Expired without confirmation" : "Unavailable without confirmation",
        state.states.filter(peer => peer.failure === failure), null])),
  ]) {
    if (!peers.length && label !== "Read by") continue;
    const section = document.createElement("section");
    const heading = document.createElement("h3"); heading.textContent = label;
    const list = document.createElement("ul");
    for (const peer of peers) {
      const row = document.createElement("li");
      const name = document.createElement("span"); name.textContent = detailsParticipantLabel(chatId, peer.publicId);
      row.append(name);
      if (timeField) {
        const time = document.createElement("span"); time.className = "receipt-time";
        time.textContent = displayTimestamp(peer[timeField], true); row.append(time);
      }
      list.append(row);
    }
    if (!peers.length) { const empty = document.createElement("li"); empty.textContent = "No one yet"; list.append(empty); }
    section.append(heading, list); groups.append(section);
  }
  const note = document.querySelector("#message-details-note");
  note.textContent = !state.recipientsKnown ? "The original recipient list is unavailable, so delivery cannot be fully confirmed."
    : state.states.some(peer => peer.failure) ? "Some recipients never confirmed delivery and the server no longer holds their copy. Your local copy is kept; check with them before sending again."
    : pending.length ? "Delivery confirmations can take a moment." : "";
  note.hidden = !note.textContent;
  positionMessageDetails();
}

function positionMessageDetails() {
  const dialog = elements.messageDetails;
  if (!dialog.open || !messageDetailsTrigger) return;
  if (mobileWorkspace()) {
    dialog.style.left = "";
    dialog.style.top = "";
    dialog.style.maxWidth = "";
    dialog.style.maxHeight = "";
    return;
  }
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft || 0) + 12;
  const top = (viewport?.offsetTop || 0) + 12;
  const right = left + (viewport?.width || window.innerWidth) - 24;
  const bottom = top + (viewport?.height || window.innerHeight) - 24;
  dialog.style.maxWidth = `${Math.max(0, right - left)}px`;
  dialog.style.maxHeight = `${Math.max(0, bottom - top)}px`;
  const box = messageDetailsTrigger.getBoundingClientRect();
  const rect = dialog.getBoundingClientRect();
  const below = box.bottom + 8;
  const preferredTop = below + rect.height <= bottom ? below : box.top - rect.height - 8;
  dialog.style.left = `${Math.max(left, Math.min(box.right - rect.width, right - rect.width))}px`;
  dialog.style.top = `${Math.max(top, Math.min(preferredTop, bottom - rect.height))}px`;
}

function showMessageDetails(chatId, entry, trigger) {
  openMessageDetails = { chatId, entry };
  messageDetailsTrigger = trigger;
  refreshMessageDetails();
  const dialog = elements.messageDetails;
  if (!dialog.open) dialog.showModal();
  positionMessageDetails();
  document.querySelector("#close-message-details").focus({ preventScroll: true });
  refreshVisibleReads();
}

function renderMessages(openAtLatest = false) {
  if (!conversationVisible()) { mediaPreviews?.clear(); return; }
  const list = elements.messageList;
  const changedChat = renderedChatId !== selectedChatId;
  const followLatest = openAtLatest || changedChat || followResizedMessages;
  followResizedMessages = followLatest;
  list.setAttribute("data-follow-latest", String(followLatest));
  if (changedChat) {
    mediaPreviews?.clear();
    releaseAllLinkPreviews();
    messageVisibilityObserver?.disconnect();
    visibleMessageNodes.clear();
    refreshVisibleReads();
    closeReactionPicker();
    for (const node of renderedMessages.values()) messageResizeObserver?.unobserve(node.messageBubble);
    list.replaceChildren();
    renderedMessages.clear();
    renderedChatId = selectedChatId;
  }
  const entries = [...(messagesByChat.get(selectedChatId) || [])]
    .filter(entry => !hiddenMessageEntry(entry)).sort((left, right) => {
      return messageDisplayTime(selectedChatId, left) - messageDisplayTime(selectedChatId, right)
        || compareHistoryEntries(left, right);
    });
  if (!entries.length) {
    mediaPreviews?.clear();
    releaseAllLinkPreviews();
    if (list.firstChild && !renderedMessages.size) return;
    for (const node of renderedMessages.values()) messageResizeObserver?.unobserve(node.messageBubble);
    list.replaceChildren();
    renderedMessages.clear();
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No messages yet.";
    list.append(empty);
    return;
  }
  if (!renderedMessages.size) list.replaceChildren();
  const keys = new Set(entries.map(entry => entry.id || entry));
  for (const [key, node] of renderedMessages) {
    if (!keys.has(key)) {
      node.releaseMedia?.();
      releaseLinkPreview(node);
      messageResizeObserver?.unobserve(node.messageBubble);
      node.remove();
      messageVisibilityObserver?.unobserve(node);
      visibleMessageNodes.delete(node);
      renderedMessages.delete(key);
    }
  }
  // Reuse formatters within this render only, so later renders pick up locale/time-zone changes.
  const timestampFormatters = new Map();
  let position = 0;
  for (const entry of entries) {
    const key = entry.id || entry;
    const messageTextContent = entry.text || "";
    const previous = entries[position - 1];
    const existing = renderedMessages.get(key);
    if (existing) {
      existing.messageEntry = entry;
      if (existing.messageText !== messageTextContent) renderMessageText(existing, messageTextContent);
      else updateLinkPreview(existing, true); // A preview that arrived after the message.
      if (entry.attachment) updateAttachmentCard(existing);
      updateMessageHeader(existing, selectedChatId, entry, previous, timestampFormatters);
      updateReactions(existing, selectedChatId, entry);
      if (list.children[position] !== existing) list.insertBefore(existing, list.children[position] || null);
      position++;
      continue;
    }
    const message = document.createElement("div");
    message.className = `message ${entry.kind}`;
    message.messageEntry = entry;
    const chatId = selectedChatId;
    if (["mine", "theirs"].includes(entry.kind)) {
      const header = document.createElement("div");
      header.className = "message-header";
      header.sender = document.createElement("span");
      header.sender.className = "message-sender";
      header.dot = document.createElement("span");
      header.dot.className = "message-separator";
      header.dot.textContent = "·";
      header.dot.setAttribute("aria-hidden", "true");
      header.timestamp = document.createElement("time");
      header.append(header.sender, header.dot, header.timestamp);
      message.messageHeader = header;
      message.append(header);
      message.setAttribute("role", "group");
    }
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    message.messageBubble = bubble;
    const text = document.createElement("span");
    text.className = "message-content";
    message.messageContent = text;
    bubble.append(text);
    if (entry.attachment) {
      bubble.className += " attachment-card";
      text.hidden = !messageTextContent;
      const download = document.createElement("button");
      download.type = "button";
      const info = document.createElement("div");
      info.className = "attachment-info";
      const size = document.createElement("small");
      size.className = "attachment-size";
      size.textContent = `${IMAGE_TYPES.includes(entry.attachment.mime) ? "Image" : "File"} · ${fileSize(entry.attachment.size)}`;
      const state = document.createElement("small");
      state.className = "attachment-state";
      state.setAttribute("role", "status");
      info.append(size, state);
      download.className = "button subtle attachment-download";
      const downloadLabel = document.createElement("span");
      downloadLabel.className = "sr-only";
      downloadLabel.textContent = "Download";
      download.append(downloadIcon(), downloadLabel);
      download.title = "Download file";
      download.setAttribute("aria-label", "Download attachment");
      const error = document.createElement("span");
      error.className = "field-error";
      error.setAttribute("role", "alert");
      download.addEventListener("click", event => {
        event.stopPropagation();
        const attachment = message.messageEntry.attachment;
        if (attachment.type === "attachment") downloadAttachment(attachment, error);
        else { mediaFailures.delete(entry.id); entry.mediaTransfer = null; scheduleMediaTransfers(); updateAttachmentCard(message); }
      });
      const tile = document.createElement("span");
      tile.className = "file-tile";
      tile.setAttribute("aria-hidden", "true");
      tile.append(fileIcon());
      bubble.append(tile, info, download, error);
      const preview = document.createElement("div");
      preview.className = "media-preview";
      bubble.append(preview);
      message.attachmentUi = { state, download, preview };
      updateAttachmentCard(message);
    }
    renderMessageText(message, messageTextContent);
    message.append(bubble);
    messageResizeObserver?.observe(bubble);
    updateMessageHeader(message, chatId, entry, previous, timestampFormatters);
    updateReactions(message, chatId, entry);
    if (entry.kind === "mine") {
      message.tabIndex = 0;
      message.setAttribute("aria-haspopup", "dialog");
      message.addEventListener("click", event => {
        if (event.target?.tagName === "BUTTON" || event.target?.closest?.("a, button")
          || window.getSelection()?.toString()) return;
        showMessageDetails(chatId, entry, message);
      });
      message.addEventListener("keydown", event => {
        if (event.target !== message || !["Enter", " "].includes(event.key)) return;
        event.preventDefault(); showMessageDetails(chatId, entry, message);
      });
    }
    list.insertBefore(message, list.children[position] || null);
    renderedMessages.set(key, message);
    if (entry.kind === "theirs" || entry.attachment) messageVisibilityObserver?.observe(message);
    position++;
  }
  if (followLatest) list.scrollTop = list.scrollHeight;
  refreshMessageDetails();
  refreshVisibleReads();
  scheduleVisiblePreviews();
}

function scheduleVisiblePreviews() {
  if (!mediaPreviews || previewTimer !== null) return;
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    if (!pageActive || document.visibilityState !== "visible" || !conversationVisible()) {
      mediaPreviews?.clear(); shownPreviews.clear(); return;
    }
    const list = elements.messageList.getBoundingClientRect();
    const candidates = new Set(messageVisibilityObserver ? visibleMessageNodes : renderedMessages.values());
    for (const node of shownPreviews) candidates.add(node);
    const near = new Set(), visible = new Set();
    const top = Math.max(0, list.top), bottom = Math.min(window.innerHeight, list.bottom);
    for (const node of candidates) {
      if (!node.previewAttached || node.isConnected === false || !node.releaseMedia.available()
          || renderedMessages.get(node.messageEntry.id || node.messageEntry) !== node) continue;
      const box = node.getBoundingClientRect();
      if (box.right <= list.left || box.left >= list.right) continue;
      if (box.bottom > top - 256 && box.top < bottom + 256) near.add(node);
      if (box.bottom > top && box.top < bottom) visible.add(node);
    }
    // Keep visible previews stable; use remaining slots for already decoded nearby images.
    const selected = new Set();
    for (const group of [[requestedPreview].filter(node => visible.has(node)),
      [...shownPreviews].filter(node => visible.has(node)), visible,
      [...shownPreviews].filter(node => near.has(node))]) {
      for (const node of group) {
        if (selected.size < SidewordMedia.MAX_ACTIVE) selected.add(node);
      }
    }
    for (const node of shownPreviews) if (!selected.has(node)) node.releaseMedia?.();
    shownPreviews.clear();
    for (const node of selected) { shownPreviews.add(node); void node.releaseMedia.load(); }
  }, 0);
}

function updateAttachmentCard(node) {
  const entry = node.messageEntry, ui = node.attachmentUi;
  if (!ui) return;
  const ready = entry.attachment.type === "attachment";
  const failure = mediaFailures.get(entry.id) || entry.mediaTransfer;
  const upload = entry.kind === "mine" && mediaUploadStates.get(metadataKey(selectedChatId, entry.clientMessageId));
  const label = ready ? upload || "Saved on this device" : failure?.attempts >= 6 ? "Unavailable · Retry download"
    : failure?.active ? "Downloading…" : "Waiting for media…";
  if (ui.state.textContent !== label) ui.state.textContent = label;
  ui.download.disabled = !ready && Boolean(failure?.active);
  ui.download.title = ready ? "Download file" : "Retry media download";
  ui.download.setAttribute("aria-label", ready ? "Download attachment" : "Retry media download");
  const image = IMAGE_TYPES.includes(entry.attachment.mime);
  const allowed = imagePreviewAllowed(entry);
  if (!ready && image && allowed) {
    ui.preview.className = "media-preview media-frame";
    if (!ui.placeholder) {
      ui.placeholder = document.createElement("span");
      ui.placeholder.setAttribute("role", "status");
      ui.preview.append(ui.placeholder);
    }
    ui.placeholder.className = failure?.attempts >= 6 ? "media-status" : "media-status media-loading";
    ui.placeholder.textContent = failure?.attempts >= 6 ? "Image unavailable" : "Loading image…";
  }
  if (!ready || !mediaPreviews || node.previewAttached
      || !(image || ["", "application/octet-stream"].includes(entry.attachment.mime))) return;
  if (allowed) {
    ui.reveal = null;
    node.previewAttached = true;
    ui.preview.replaceChildren();
    node.releaseMedia = mediaPreviews.attach(ui.preview,
      () => SidewordProtocol.attachmentBytes(node.messageEntry.attachment), entry.attachment.mime,
      trigger => openImageViewer(node.messageEntry, trigger));
  } else if (image && !ui.reveal) {
    // Hidden images are neither copied to Blob URLs nor decoded until the user asks.
    ui.reveal = document.createElement("button");
    ui.reveal.type = "button";
    ui.reveal.className = "button subtle media-reveal";
    ui.reveal.textContent = "Show image";
    ui.reveal.addEventListener("click", event => { event?.stopPropagation?.(); revealImage(node); });
    ui.preview.className = "media-preview";
    ui.preview.replaceChildren(ui.reveal);
  }
}

// Decrypted text stays text: links are DOM anchors whose visible text is the exact typed substring.
function renderMessageText(message, messageText) {
  const content = message.messageContent;
  const links = message.messageEntry.kind === "system" ? [] : globalThis.SidewordLinks?.findLinks(messageText) || [];
  message.messageText = messageText;
  message.messageLinks = links;
  // One to three emoji alone are shown larger; text, links, files and system notes are not.
  const entry = message.messageEntry;
  const largeEmoji = entry.kind === "system" || entry.attachment || links.length ? 0
    : globalThis.SidewordEmoji?.largeEmojiCount(messageText) || 0;
  if ((message.largeEmoji || 0) !== largeEmoji) {
    message.largeEmoji = largeEmoji;
    message.messageBubble.classList.toggle("emoji-only", largeEmoji > 0);
    if (largeEmoji) message.messageBubble.dataset.emojiCount = String(largeEmoji);
    else delete message.messageBubble.dataset.emojiCount;
  }
  if (!links.length) content.textContent = messageText;
  else {
    const parts = [];
    let offset = 0;
    for (const link of links) {
      if (link.start > offset) parts.push(messageText.slice(offset, link.start));
      parts.push(messageLink(link));
      offset = link.end;
    }
    if (offset < messageText.length) parts.push(messageText.slice(offset));
    content.replaceChildren(...parts);
  }
  updateLinkWarning(message);
  updateLinkPreview(message);
}

function externalLinkAttributes(anchor, link) {
  anchor.href = link.href;
  anchor.setAttribute("target", "_blank");
  anchor.setAttribute("rel", "noopener noreferrer nofollow");
  anchor.setAttribute("referrerpolicy", "no-referrer");
  anchor.title = `${link.warnings.length ? `Check before opening: ${link.warnings.join("; ")}. ` : ""}`
    + `Opens in a new tab: ${link.href}`;
}

function messageLink(link) {
  const anchor = document.createElement("a");
  anchor.className = link.warnings.length ? "message-link suspicious-link" : "message-link";
  externalLinkAttributes(anchor, link);
  anchor.setAttribute("aria-describedby", link.warnings.length
    ? "external-link-note suspicious-link-note" : "external-link-note");
  anchor.textContent = link.text;
  return anchor;
}

// Suspicious hosts get a short inline note under the text, independent of previews.
function updateLinkWarning(message) {
  const link = (message.messageLinks || []).find(candidate => candidate.warnings.length);
  const text = link ? `Check ${link.host}: ${link.warnings.join("; ")}` : "";
  if ((message.linkWarning?.textContent || "") === text) return;
  message.linkWarning?.remove();
  message.linkWarning = null;
  if (text) {
    message.linkWarning = document.createElement("span");
    message.linkWarning.className = "link-warning";
    message.linkWarning.textContent = text;
    message.messageContent.after(message.linkWarning);
  }
  updateLinkLayout(message);
}

function updateLinkLayout(message) {
  message.messageBubble.classList.toggle("has-link-extras", Boolean(message.linkWarning || message.linkCard));
}

function previewableLink(link) {
  return link.protocol === "https:" && !link.port && !link.credentials;
}

// Previews are made by the sender and travel inside the encrypted message, so rendering never
// contacts any server: a link's owner cannot learn when a recipient opened the message.
function updateLinkPreview(message, late = false) {
  const preview = linkPreviewMode === "on" && !message.messageEntry.attachment ? messagePreview(message) : null;
  const key = preview?.url || "";
  if ((message.linkPreviewKey || "") === key && Boolean(message.linkCard) === Boolean(key)) return;
  releaseLinkPreview(message);
  if (!preview) return;
  const link = (message.messageLinks || []).find(previewableLink);
  if (late) revealLinkPreview(message, link, preview);
  else showLinkPreview(message, link, preview);
}

// The payload preview must describe the message's first previewable link; anything else is ignored.
function messagePreview(message) {
  const preview = message.messageEntry.preview;
  const link = (message.messageLinks || []).find(previewableLink);
  if (!preview || !link || preview.url !== link.href) return null;
  if (!decodedLinkPreviews.has(preview)) decodedLinkPreviews.set(preview, displayLinkPreview(preview));
  return decodedLinkPreviews.get(preview);
}

function displayLinkPreview(preview) {
  let image = null;
  if (preview.image) {
    try {
      const bytes = SidewordProtocol.base64ToBytes(preview.image.data);
      const info = globalThis.SidewordMedia?.inspect(bytes, "image/jpeg");
      if (info) image = { bytes, banner: info.width >= 300 && info.width / info.height >= 1.3 };
    } catch { image = null; }
  }
  return { url: preview.url, title: preview.title, description: preview.description,
    siteName: preview.site_name, finalHost: preview.final_host, image };
}

// Bounded parallel loading for the sender's draft; one request per address.
function drainLinkPreviews() {
  while (linkPreviewPending.size < LINK_PREVIEW_PARALLEL && linkPreviewQueue.size && linkPreviewMode === "on") {
    const [key, waiting] = [...linkPreviewQueue].at(-1);
    linkPreviewQueue.delete(key);
    if (!linkPreviewWanted(key)) continue;
    linkPreviewPending.set(key, waiting);
    void loadLinkPreview(key, waiting);
  }
}

async function loadLinkPreview(key, waiting) {
  const generation = linkPreviewGeneration;
  waiting.controller = new AbortController();
  try {
    const preview = await fetchLinkPreview(waiting.link, waiting.controller.signal);
    // Turned off, session changed, or the draft dropped this address meanwhile: keep nothing.
    if (generation !== linkPreviewGeneration || !linkPreviewWanted(key)) return;
    rememberLinkPreview(key, preview);
    const sent = sentLinkPreviews.get(key) || [];
    sentLinkPreviews.delete(key);
    if (preview) for (const item of sent) void sendLinkPreviewFollowUp(item, waiting.link, preview);
  } finally {
    if (linkPreviewPending.get(key) === waiting) linkPreviewPending.delete(key);
    drainLinkPreviews();
  }
}

// Failures return null, so the message is sent with its inline link only.
async function fetchLinkPreview(link, signal) {
  for (let attempt = 0; attempt < 3 && !signal?.aborted; attempt++) {
    try {
      const result = await api("/api/v1/link-previews", { method: "POST", body: JSON.stringify({ url: link.href }), signal });
      const preview = checkedLinkPreview(result);
      if (preview) preview.image = await linkPreviewImage(result.image);
      return preview;
    } catch (error) {
      if (!/\(HTTP 429\)/u.test(error?.message || "") || attempt === 2) return null;
      await new Promise(resolve => window.setTimeout(resolve, LINK_PREVIEW_RETRY_MS * (attempt + 1)));
    }
  }
  return null;
}

function checkedLinkPreview(result) {
  if (!result || typeof result !== "object") return null;
  const text = (value, limit) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
  const finalHost = typeof result.final_host === "string" && /^[a-z0-9.:-]{1,253}$/u.test(result.final_host)
    ? result.final_host : null;
  const preview = { title: text(result.title, 200), description: text(result.description, 400),
    siteName: text(result.site_name, 80), finalHost, image: null };
  // Many sites repeat the description inside the title ("Site - name: description"): keep the
  // title's own part and show the description once with more room.
  const normalized = value => value?.toLocaleLowerCase().replace(/\s+/gu, " ");
  const description = normalized(preview.description);
  const prefix = description?.slice(0, Math.min(40, Math.max(12, Math.floor(description.length * .6))));
  const repeatedAt = preview.title && prefix ? normalized(preview.title).indexOf(prefix) : -1;
  if (repeatedAt > 0) {
    const title = preview.title.replace(/\s+/gu, " ");
    let end = repeatedAt;
    while (end > 0 && " :|·•–—-".includes(title[end - 1])) end--; // Drop the joining punctuation.
    preview.title = title.slice(0, end) || preview.title;
  } else if (repeatedAt === 0) preview.description = null;
  return preview.title || preview.description || result.image ? preview : null;
}

// Remote bytes are revalidated and re-encoded locally; only the small JPEG is kept.
async function linkPreviewImage(image) {
  const media = globalThis.SidewordMedia;
  if (!media || !image || typeof image.data !== "string" || !IMAGE_TYPES.includes(image.mime)
      || image.data.length > Math.ceil(media.MAX_BYTES / 3) * 4) return null;
  try {
    const bytes = SidewordProtocol.base64ToBytes(image.data);
    const info = media.inspect(bytes, image.mime);
    if (!info) return null;
    const banner = info.width >= 300 && info.width / info.height >= 1.3;
    const size = banner ? LINK_BANNER : LINK_THUMBNAIL;
    const reduced = await media.reduceImage(bytes, image.mime, size.bytes, () => linkPreviewMode === "on", size.dimension);
    return reduced ? { bytes: reduced, banner } : null;
  } catch { return null; }
}

function rememberLinkPreview(href, preview) {
  linkPreviewResults.delete(href);
  linkPreviewResults.set(href, preview);
  while (linkPreviewResults.size > LINK_PREVIEW_CACHE_SIZE) linkPreviewResults.delete(linkPreviewResults.keys().next().value);
}

function linkPreviewWanted(key) {
  return draftLinkPreviews.has(key) || sentLinkPreviews.has(key);
}

// At send time: the draft's already loaded preview for the message's first previewable link.
// Sending never waits; a preview still loading follows later in its own encrypted message.
function sendLinkPreview(text, recipientCount) {
  if (linkPreviewMode !== "on") return null;
  const link = (globalThis.SidewordLinks?.findLinks(text) || []).find(previewableLink);
  const preview = link ? linkPreviewResults.get(link.href) : null;
  return preview ? linkPreviewPayload(link, preview, recipientCount) : null;
}

function linkPreviewPayload(link, preview, recipientCount) {
  const payload = { url: link.href, title: preview.title, description: preview.description,
    site_name: preview.siteName, final_host: preview.finalHost, image: null };
  // Each recipient gets its own copy: include the image only when all copies stay well in budget.
  if (preview.image && preview.image.bytes.length <= SidewordProtocol.MAX_PREVIEW_IMAGE_BYTES
      && (preview.image.bytes.length * 2 + 4096) * recipientCount <= SidewordProtocol.MAX_SEND_BYTES / 2) {
    payload.image = { mime: "image/jpeg", data: SidewordProtocol.bytesToBase64(preview.image.bytes) };
  }
  return payload.title || payload.description || payload.image ? payload : null;
}

// A preview never blocks or delays sending: anything unusable falls back to the plain text payload.
function textPayloadWithPreview(text, recipientCount) {
  try {
    const preview = sendLinkPreview(text, recipientCount);
    if (preview) return SidewordProtocol.textPayload(text, preview);
  } catch { /* Send the message without a preview. */ }
  return SidewordProtocol.textPayload(text);
}

// After sending a link whose preview was not ready: keep (or start) loading it for this message.
function followUpLinkPreview(chatId, messageId, text, recipients) {
  if (linkPreviewMode !== "on" || !linkPreviewsAvailable) return;
  const link = (globalThis.SidewordLinks?.findLinks(text) || []).find(previewableLink);
  if (!link) return;
  const item = { chatId, messageId, recipientIds: recipients.map(recipient => recipient.public_id) };
  if (linkPreviewResults.has(link.href)) {
    // Finished while the message was being encrypted (or failed earlier): follow up now or skip.
    const ready = linkPreviewResults.get(link.href);
    if (ready) void sendLinkPreviewFollowUp(item, link, ready);
    return;
  }
  const waiting = sentLinkPreviews.get(link.href) || [];
  waiting.push(item);
  sentLinkPreviews.set(link.href, waiting);
  if (!linkPreviewPending.has(link.href) && !linkPreviewQueue.has(link.href)) {
    linkPreviewQueue.set(link.href, { link });
    scheduleLinkPreviewDrain();
  }
}

// Sends the loaded preview to the original recipients, bound to the original message ID.
// Best effort: the message itself is already delivered, so failures only skip the card.
async function sendLinkPreviewFollowUp(item, link, preview) {
  const chat = chats.find(candidate => candidate.id === item.chatId);
  if (!chat || chat.closed_at || linkPreviewMode !== "on" || !identity?.publicId) return;
  const recipients = chat.participants.filter(peer => item.recipientIds.includes(peer.public_id));
  const previewPayload = recipients.length ? linkPreviewPayload(link, preview, recipients.length) : null;
  if (!previewPayload) return;
  try {
    for (const recipient of recipients) await assertTrustedPeer(recipient);
    await queueEncryptedMessage(chat, recipients, crypto.randomUUID(),
      SidewordProtocol.linkPreviewPayload(item.messageId, previewPayload));
    try { await flushOutbox(); }
    finally { await renderOutbox(); }
  } catch { /* The message was sent; only its preview is skipped. */ }
}

function linkPreviewPart(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Compact card: optional banner, host and site line, title, description and side thumbnail.
function createLinkCard(link, preview) {
  const card = document.createElement("a");
  card.className = link.warnings.length ? "link-card suspicious-link" : "link-card";
  externalLinkAttributes(card, link);
  // The inline link is the keyboard target; the card is an equivalent pointer target.
  card.tabIndex = -1;
  const url = preview.image ? URL.createObjectURL(new Blob([preview.image.bytes], { type: "image/jpeg" })) : null;
  const images = [];
  const image = className => {
    const node = linkPreviewPart("img", className);
    node.alt = "";
    node.decoding = "async";
    node.src = url;
    images.push(node);
    return node;
  };
  if (url && preview.image.banner) card.append(image("link-card-banner"));
  const body = linkPreviewPart("span", "link-card-body");
  const text = linkPreviewPart("span", "link-card-text");
  const host = link.displayHost.replace(/^www\./u, "");
  const via = preview.finalHost && preview.finalHost !== link.host ? ` → ${preview.finalHost}` : "";
  // Skip a site name that only restates the host, such as "GitHub" for github.com.
  const siteKey = preview.siteName?.toLowerCase().replace(/[\s.]+/gu, "");
  const redundant = !siteKey || host.split(".").includes(siteKey) || host.replaceAll(".", "") === siteKey;
  const source = [`${host}${via}`, redundant ? null : preview.siteName];
  text.append(linkPreviewPart("span", "link-card-source", source.filter(Boolean).join(" · ")));
  if (preview.title) text.append(linkPreviewPart("span", "link-card-title", preview.title));
  if (preview.description) text.append(linkPreviewPart("span", "link-card-description", preview.description));
  body.append(text);
  if (url && !preview.image.banner) body.append(image("link-card-thumbnail"));
  card.append(body);
  return { card, url, images };
}

function placeLinkCard(message, link, created) {
  releaseLinkPreview(message);
  message.linkPreviewKey = link.href;
  if (created.url) linkPreviewUrls.set(message, created.url);
  message.linkCard = created.card;
  (message.linkWarning || message.messageContent).after(created.card);
  updateLinkLayout(message);
}

function showLinkPreview(message, link, preview) {
  placeLinkCard(message, link, createLinkCard(link, preview));
}

// A preview that arrives after its message fades in while the bubble eases to its new size;
// offscreen or with reduced motion it appears at once without moving the reading position.
function revealLinkPreview(message, link, preview) {
  if (reducedMotion() || !messageInView(message)) {
    keepScrollPosition(() => showLinkPreview(message, link, preview));
    return;
  }
  const bubble = message.messageBubble;
  for (const animation of bubble.getAnimations?.() || []) animation.finish();
  const before = bubble.getBoundingClientRect();
  showLinkPreview(message, link, preview);
  const after = bubble.getBoundingClientRect();
  const timing = { duration: LINK_CARD_ANIMATION_MS, easing: "cubic-bezier(.2, 0, 0, 1)" };
  // Animate real sizes, not a scale transform, so text never distorts; no fill is kept.
  if (Math.abs(before.width - after.width) >= 1 || Math.abs(before.height - after.height) >= 1) {
    bubble.animate?.([{ width: `${before.width}px`, height: `${before.height}px`, overflow: "hidden" },
      { width: `${after.width}px`, height: `${after.height}px`, overflow: "hidden" }], timing);
  }
  message.linkCard?.animate?.([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }],
    { duration: LINK_CARD_ANIMATION_MS, easing: "ease-out" });
}

function reducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function messageInView(message) {
  const bubble = message.messageBubble.getBoundingClientRect();
  const list = elements.messageList.getBoundingClientRect();
  return bubble.bottom > list.top && bubble.top < list.bottom;
}

// Keeps the first visible message in place when content above it changes size; following the
// latest message is already handled by the resize observer. Works without CSS scroll anchoring.
function keepScrollPosition(change) {
  const list = elements.messageList;
  if (followResizedMessages || !conversationVisible()) { change(); return; }
  const top = list.getBoundingClientRect().top;
  const anchor = [...list.children].find(node => node.getBoundingClientRect().bottom > top);
  const before = anchor?.getBoundingClientRect().top;
  change();
  if (anchor && anchor.isConnected !== false && before !== undefined) {
    list.scrollTop += anchor.getBoundingClientRect().top - before;
  }
}

function releaseLinkPreview(message) {
  const url = linkPreviewUrls.get(message);
  if (url) {
    linkPreviewUrls.delete(message);
    URL.revokeObjectURL(url);
  }
  message.linkPreviewKey = "";
  if (!message.linkCard) return;
  message.linkCard.remove();
  message.linkCard = null;
  updateLinkLayout(message);
}

function releaseAllLinkPreviews() {
  for (const message of renderedMessages.values()) releaseLinkPreview(message);
  for (const message of [...linkPreviewUrls.keys()]) releaseLinkPreview(message);
}

function resetLinkPreviewRequests() {
  linkPreviewGeneration++;
  for (const waiting of linkPreviewPending.values()) waiting.controller?.abort();
  linkPreviewQueue.clear();
  linkPreviewPending.clear();
  linkPreviewResults.clear();
  draftLinkPreviews.clear();
  sentLinkPreviews.clear();
  window.clearTimeout(draftPrefetchTimer);
}

// Prefetch the draft's previewable link so the sent message renders with its card at once.
function syncDraftLinkPreviews({ immediate = false } = {}) {
  window.clearTimeout(draftPrefetchTimer);
  const text = elements.messageInput.value;
  const link = (globalThis.SidewordLinks?.findLinks(text) || []).find(previewableLink);
  for (const href of [...draftLinkPreviews]) if (href !== link?.href) discardDraftLinkPreview(href);
  if (!link || linkPreviewMode !== "on" || !linkPreviewsAvailable) return;
  // A URL at the very end may still be typed; wait for following text, a paste, or a pause.
  if (immediate || link.end < text.length) prefetchLinkPreview(link);
  else draftPrefetchTimer = window.setTimeout(() => syncDraftLinkPreviews({ immediate: true }), LINK_PREFETCH_IDLE_MS);
}

function prefetchLinkPreview(link) {
  const key = link.href;
  draftLinkPreviews.add(key);
  if (linkPreviewResults.has(key) || linkPreviewPending.has(key) || linkPreviewQueue.has(key)) return;
  linkPreviewQueue.set(key, { link });
  scheduleLinkPreviewDrain();
}

// Removed before sending: forget the result and cancel the request, unless a sent message
// still waits for this preview.
function discardDraftLinkPreview(href) {
  draftLinkPreviews.delete(href);
  if (sentLinkPreviews.has(href)) return;
  linkPreviewResults.delete(href);
  linkPreviewQueue.delete(href);
  linkPreviewPending.get(href)?.controller?.abort();
}

function scheduleLinkPreviewDrain() {
  if (linkPreviewDrainScheduled) return;
  linkPreviewDrainScheduled = true;
  void Promise.resolve().then(() => { linkPreviewDrainScheduled = false; drainLinkPreviews(); });
}

function readLinkPreviewMode() {
  try { return window.localStorage.getItem(LINK_PREVIEW_KEY) === "off" ? "off" : "on"; }
  catch { return "on"; } // Unavailable storage keeps the default.
}

function applyLinkPreviewMode(mode, save = false) {
  linkPreviewMode = mode === "on" ? "on" : "off";
  elements.linkPreviewsOff.checked = linkPreviewMode === "off";
  elements.linkPreviewsOn.checked = linkPreviewMode === "on";
  if (save) {
    try { window.localStorage.setItem(LINK_PREVIEW_KEY, linkPreviewMode); }
    catch { /* The visible choice still applies for this page. */ }
  }
  if (linkPreviewMode === "off") { releaseAllLinkPreviews(); resetLinkPreviewRequests(); }
  keepScrollPosition(() => { for (const node of renderedMessages.values()) updateLinkPreview(node); });
  syncDraftLinkPreviews();
}

// Availability only affects creating previews for sent links; received previews always show.
function setLinkPreviewsAvailable(available) {
  linkPreviewsAvailable = available;
  elements.linkPreviewsUnavailable.hidden = available;
  syncDraftLinkPreviews();
}

function readImagePreviewMode() {
  try { return window.localStorage.getItem(IMAGE_PREVIEW_KEY) === "reveal" ? "reveal" : "auto"; }
  catch { return "auto"; } // Unavailable storage keeps the default.
}

function imagePreviewAllowed(entry) {
  return entry.kind === "mine" || imagePreviewMode === "auto"
    || (IMAGE_TYPES.includes(entry.attachment.mime) && revealedImages.has(entry.id));
}

function applyImagePreviewMode(mode, save = false) {
  imagePreviewMode = mode === "reveal" ? "reveal" : "auto";
  elements.imagePreviewReveal.checked = imagePreviewMode === "reveal";
  elements.imagePreviewAuto.checked = imagePreviewMode === "auto";
  if (save) {
    try { window.localStorage.setItem(IMAGE_PREVIEW_KEY, imagePreviewMode); }
    catch { /* The visible choice still applies for this page. */ }
  }
  for (const node of renderedMessages.values()) {
    if (!node.attachmentUi) continue;
    if (node.previewAttached && !imagePreviewAllowed(node.messageEntry)) hideImagePreview(node);
    updateAttachmentCard(node);
  }
  if (renderedMessages.size) scheduleVisiblePreviews();
}

function hideImagePreview(node) {
  node.releaseMedia?.();
  shownPreviews.delete(node);
  // The media manager owns one control per host, so hidden cards get a fresh host.
  const preview = document.createElement("div");
  preview.className = "media-preview";
  node.messageBubble.insertBefore(preview, node.attachmentUi.preview);
  node.attachmentUi.preview.remove();
  node.attachmentUi.preview = preview;
  node.attachmentUi.reveal = null;
  node.previewAttached = false;
  node.releaseMedia = null;
}

function revealImage(node) {
  revealedImages.add(node.messageEntry.id);
  requestedPreview = node;
  const host = node.attachmentUi.preview;
  updateAttachmentCard(node);
  // Hold focus on the frame; the decoded image button takes it over.
  host.tabIndex = -1;
  host.focus({ preventScroll: true });
  scheduleVisiblePreviews();
}

function releaseViewerImage() {
  if (imageViewer.image) {
    imageViewer.image.removeAttribute("src");
    imageViewer.image.remove();
    imageViewer.image = null;
  }
  if (imageViewer.url) { URL.revokeObjectURL(imageViewer.url); imageViewer.url = null; }
  imageViewer.width = imageViewer.height = 0;
}

async function openImageViewer(entry, trigger) {
  const dialog = elements.imageViewer;
  const token = ++imageViewer.token;
  releaseViewerImage();
  Object.assign(imageViewer, { entry, chatId: selectedChatId, trigger, zoom: 1 });
  elements.imageViewerError.textContent = "";
  elements.imageViewerStatus.className = "media-status media-loading";
  elements.imageViewerStatus.textContent = "Loading image…";
  layoutImageViewer();
  if (!dialog.open) dialog.showModal();
  document.querySelector("#close-image-viewer").focus({ preventScroll: true });
  refreshVisibleReads();
  try {
    // The viewer owns a separate validated copy, so inline cleanup cannot break it.
    const prepared = SidewordMedia.previewBlob(SidewordProtocol.attachmentBytes(entry.attachment), entry.attachment.mime);
    const image = document.createElement("img");
    if (!prepared || typeof image.decode !== "function") throw new ClientError("Unsupported image");
    image.alt = "Image attachment";
    image.className = "viewer-image";
    image.decoding = "async";
    image.draggable = false;
    imageViewer.image = image;
    imageViewer.url = URL.createObjectURL(prepared.blob);
    image.src = imageViewer.url;
    await image.decode();
    if (token !== imageViewer.token) return;
    if (!SidewordMedia.decodedMatches(image, prepared.info)) throw new ClientError("Invalid image");
    imageViewer.width = image.naturalWidth;
    imageViewer.height = image.naturalHeight;
    elements.imageViewerStatus.className = "media-status";
    elements.imageViewerStatus.textContent = "";
    elements.imageStage.append(image);
    layoutImageViewer();
  } catch {
    if (token !== imageViewer.token) return;
    releaseViewerImage();
    elements.imageViewerStatus.className = "media-status";
    elements.imageViewerStatus.textContent = "This image cannot be displayed. Download the file instead.";
  }
}

function setViewerZoom(zoom) {
  const stage = elements.imageStage;
  // Keep the visible center stable while zooming.
  const centerX = stage.scrollWidth ? (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : .5;
  const centerY = stage.scrollHeight ? (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : .5;
  imageViewer.zoom = Math.min(VIEWER_ZOOM_LEVELS.at(-1), Math.max(1, zoom));
  layoutImageViewer();
  if (stage.scrollWidth) stage.scrollLeft = centerX * stage.scrollWidth - stage.clientWidth / 2;
  if (stage.scrollHeight) stage.scrollTop = centerY * stage.scrollHeight - stage.clientHeight / 2;
}

function stepViewerZoom(direction) {
  const levels = direction > 0 ? VIEWER_ZOOM_LEVELS : [...VIEWER_ZOOM_LEVELS].reverse();
  const next = levels.find(level => direction > 0 ? level > imageViewer.zoom : level < imageViewer.zoom);
  if (next !== undefined) setViewerZoom(next);
}

function layoutImageViewer() {
  const zoom = imageViewer.zoom, loaded = Boolean(imageViewer.image && imageViewer.width);
  elements.imageZoomFit.textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`;
  elements.imageZoomFit.setAttribute("aria-label", zoom === 1 ? "Fitted to screen" : `Zoom ${Math.round(zoom * 100)}%, fit to screen`);
  elements.imageZoomIn.disabled = !loaded || zoom >= VIEWER_ZOOM_LEVELS.at(-1);
  elements.imageZoomOut.disabled = !loaded || zoom <= 1;
  elements.imageZoomFit.disabled = !loaded || zoom === 1;
  if (!loaded) return;
  const stage = elements.imageStage, width = imageViewer.width, height = imageViewer.height;
  // Fit never upscales; zoom multiplies the fitted size and the stage scrolls.
  const fit = Math.min(1, (stage.clientWidth || width) / width, (stage.clientHeight || height) / height);
  imageViewer.image.style.width = `${Math.max(1, Math.round(width * fit * zoom))}px`;
  imageViewer.image.style.height = `${Math.max(1, Math.round(height * fit * zoom))}px`;
}

function chatName(chat) {
  if (chat.title) return chat.title;
  const peers = chat.participants.filter((participant) => participant.public_id !== identity.publicId);
  return peers.map((peer) => peer.display_name || peer.public_id).join(", ") || "Waiting for peer";
}

function renderChats() {
  const focusedChatId = document.activeElement?.dataset?.chatId;
  elements.chatList.replaceChildren();
  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No chats yet. Activate an invite.";
    elements.chatList.append(empty);
    return;
  }
  for (const chat of chats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-button${chat.id === selectedChatId ? " active" : ""}`;
    button.dataset.chatId = String(chat.id);
    button.setAttribute("aria-current", chat.id === selectedChatId ? "true" : "false");
    const title = document.createElement("strong");
    title.textContent = chatName(chat);
    const detail = document.createElement("span");
    detail.textContent = `${chat.closed_at ? "Closed · " : ""}${chat.chat_type} · ${chat.participants.length} participant${chat.participants.length === 1 ? "" : "s"}`;
    button.append(title, detail);
    button.addEventListener("click", () => {
      elements.clientPanel.dataset.mobileView = "conversation";
      selectChat(chat.id, mobileWorkspace());
      rememberChatView("conversation", chat.id);
      if (mobileWorkspace()) {
        if (!elements.messageInput.disabled) elements.messageInput.focus({ preventScroll: true });
        else elements.conversationTitle.focus({ preventScroll: true });
      }
    });
    const row = document.createElement("div");
    row.setAttribute("role", "listitem");
    row.append(button);
    elements.chatList.append(row);
    if (focusedChatId === String(chat.id)) button.focus({ preventScroll: true });
  }
}

function selectChat(chatId, openAtLatest = false) {
  const changedChat = renderedChatId !== chatId;
  if (selectedChatId !== chatId && !sendingMessage) clearAttachment();
  selectedChatId = chatId;
  if (openMessageDetails && openMessageDetails.chatId !== chatId) elements.messageDetails.close();
  if (elements.imageViewer.open && imageViewer.chatId !== chatId) elements.imageViewer.close();
  if (changedChat) requestedPreview = null;
  const chat = chats.find((candidate) => candidate.id === chatId);
  elements.conversationKind.textContent = chat?.closed_at
    ? "Closed · Saved history" : chat?.chat_type || "Conversation";
  elements.conversationTitle.textContent = chat ? chatName(chat) : "No conversation selected";
  elements.detailsButton.disabled = !chat;
  const changedKey = Boolean(chat?.participants.some(item => item.key_changed));
  elements.keyWarning.hidden = !changedKey;
  const warningText = changedKey
    ? "KEY CHANGED; blocked. A participant's encryption key changed and no longer matches the fingerprint saved on this device. Sending and decryption are blocked. Keep this device's history."
    : "";
  if (elements.keyWarning.textContent !== warningText) elements.keyWarning.textContent = warningText;
  renderParticipantDetails(chat);
  const hasPeers = Boolean(chat?.participants.some(item => item.public_id !== identity.publicId));
  const waitingForPeer = Boolean(chat && !chat.closed_at && !changedKey && !hasPeers);
  const canSend = Boolean(chat && !chat.closed_at && !changedKey && hasPeers);
  elements.waitingNotice.hidden = !waitingForPeer;
  elements.messageInput.disabled = !canSend;
  elements.messageInput.placeholder = waitingForPeer ? "Waiting for another participant…" : "Write a message";
  elements.sendButton.disabled = !canSend || sendingMessage || composerPreview.optimizing;
  elements.attachmentButton.disabled = !canSend || sendingMessage;
  elements.attachmentInput.disabled = !canSend || sendingMessage;
  emojiPicker?.setEnabled(canSend);
  elements.messageInput.hidden = false;
  elements.messageForm.classList.toggle("has-attachment", Boolean(selectedFile));
  elements.sendButton.textContent = sendingMessage ? "Sending…" : composerPreview.optimizing ? "Reducing…"
    : selectedFile ? "Send file" : "Send";
  elements.attachmentButton.setAttribute("aria-label", selectedFile ? "Replace attached file" : "Attach a file");
  document.querySelector("#composer-help").textContent = chat?.closed_at
    ? "Conversation closed. Saved history is kept; messaging is paused."
    : changedKey ? "Messaging is blocked because a participant's encryption key changed."
    : waitingForPeer ? "Sending is unavailable until another participant joins."
    : !chat ? "Select a conversation to send a message."
    : selectedFile ? "Ready to send · Optional message above the attachment"
    : "Enter to send · Shift+Enter for a new line";
  renderChats();
  renderMessages(openAtLatest);
  if (canSend && changedChat && !elements.clientPanel.hidden
      && !elements.detailsDialog.open && !elements.deviceDialog.open
      && (!mobileWorkspace() || elements.clientPanel.dataset.mobileView === "conversation")) {
    elements.messageInput.focus({ preventScroll: true });
  }
}

function updateIdentityUi() {
  const active = Boolean(!invitePending && identity?.token && identity?.publicId);
  elements.loadingPanel.hidden = true;
  elements.setupPanel.hidden = active;
  elements.clientPanel.hidden = !active;
  if (!active && elements.detailsDialog.open) elements.detailsDialog.close();
  if (!active && elements.imageViewer.open) elements.imageViewer.close();
  document.querySelector("#reconnect-session").hidden = invitePending || active || !identity?.suspendedToken;
  updateConnectionState(false);
  if (active) renderMessages();
}

function updateConnectionState(connected) {
  if (!connected) clearPresence();
  const active = Boolean(!invitePending && identity?.token && identity?.publicId);
  elements.connectionState.classList.toggle("online", active && connected);
  elements.identityLabel.textContent = active
    ? (connected ? "Connected" : "Connected · updates may be delayed")
    : "Not signed in";
  elements.connectionLabel.textContent = active ? (connected ? "Live" : "Polling") : "Offline";
  elements.devicePublicId.textContent = identity?.publicId || "Not signed in";
}

async function loadChats() {
  if (invitePending || !identity?.token) return;
  const data = await api("/api/v1/me");
  const deadline = data.session_expires_at || data.access_expires_at;
  accessDeadline = deadline
    ? performance.now() + serverTimestamp(deadline) - serverTimestamp(data.server_time)
    : null;
  checkAccessExpiry();
  if (data.user.public_key !== identity.publicKey) {
    throw new ClientError("The server's account encryption key differs from this device's saved key. The login and local device identity do not match. Keep this device's history.");
  }
  const checkedChats = [];
  for (const chat of data.chats) {
    const participants = [];
    for (const peer of chat.participants) participants.push(await observePeerKey(peer));
    checkedChats.push({ ...chat, participants });
  }
  identity.publicId = data.user.public_id;
  identity.retryWindowSeconds = data.send_retry_window_seconds;
  if (!Number.isSafeInteger(data.receipt_retention_seconds) || data.receipt_retention_seconds <= 0) {
    throw new ClientError("The service returned incomplete message retention information.");
  }
  identity.receiptRetentionSeconds = data.receipt_retention_seconds;
  setLinkPreviewsAvailable(data.link_previews_available === true);
  messageProfileReady = true;
  await writeIdentity(identity);
  chats = checkedChats;
  if (selectedChatId && !chats.some((chat) => chat.id === selectedChatId)) {
    selectedChatId = null;
    if (mobileWorkspace()) {
      elements.clientPanel.setAttribute("data-mobile-view", "chats");
      rememberChatView("chats", null);
    }
  }
  if (!selectedChatId && chats.length) selectedChatId = chats[0].id;
  if (selectedChatId) selectChat(selectedChatId);
  else selectChat(null);
}

function senderKeyIsLoaded(message) {
  const chat = chats.find((candidate) => candidate.id === message.chat_id);
  return Boolean(
    chat?.participants.some(
      (participant) => participant.public_id === message.sender_public_id,
    ),
  );
}

function deliveryReference(delivery, peerField) {
  if (!/^[0-9a-f]{32}$/.test(delivery.delivery_id || "")) {
    throw new ClientError("The server sent incomplete delivery information. This client cannot safely confirm that the message was received, so it stays queued.");
  }
  return {
    delivery_id: delivery.delivery_id,
    chat_id: delivery.chat_id,
    client_message_id: delivery.client_message_id,
    [peerField]: delivery[peerField],
  };
}

function queueRead(message) {
  if (acknowledgedReads.has(message.delivery_id)) return;
  const reference = deliveryReference(message, "sender_public_id");
  const ids = pendingReadsByChat.get(message.chat_id) || new Map();
  ids.set(message.delivery_id, reference);
  pendingReadsByChat.set(message.chat_id, ids);
}

function queueDelivery(message) {
  if (acknowledgedDeliveries.has(message.delivery_id)) return;
  pendingDeliveries.set(message.delivery_id, deliveryReference(message, "sender_public_id"));
}

async function flushDeliveryBatch(path, field, pending, marker = null) {
  // Keep each failed batch queued. Delete only the successful snapshot so a
  // delivery added during the request cannot be lost.
  while (pending.size) {
    const batch = [...pending.values()].slice(0, 100);
    await api(path, {
      method: "POST",
      body: JSON.stringify({ [field]: batch }),
    });
    for (const reference of batch) {
      if (marker) await appendMessage(reference.chat_id, {
        id: `${marker}:${reference.delivery_id}`, kind: marker, delivery: reference,
      });
      pending.delete(reference.delivery_id);
    }
  }
}

async function flushDurableDeliveries() {
  await flushDeliveryBatch("/api/v1/ack/exact", "messages", pendingDeliveries,
    "delivery_ack");
}

async function flushAcknowledgements() {
  await flushDurableDeliveries();
  if (messageProfileReady) {
    for (const [chatId, ids] of pendingReadsByChat) {
      if (chats.find(chat => chat.id === chatId)?.closed_at) continue;
      await flushDeliveryBatch(`/api/v1/chats/${chatId}/read/exact`, "messages", ids,
        "read_ack");
      pendingReadsByChat.delete(chatId);
    }
  }
  await flushDeliveryBatch("/api/v1/ack/exact", "receipts", pendingReceiptIds);
}

async function processMessages(messages) {
  const needsFreshChat = messages.some(
    (message) => !seenMessageIds.has(messageKey(message)) && !senderKeyIsLoaded(message),
  );
  if (needsFreshChat) await loadChats();

  for (const message of messages) {
    const key = messageKey(message);
    if (seenMessageIds.has(key)) {
      const reference = deliveryReference(message, "sender_public_id");
      if (!deliveryReferences.get(key)?.has(reference.delivery_id)) {
        await appendMessage(message.chat_id, { id: `delivery_ref:${reference.delivery_id}`,
          kind: "delivery_ref", messageKey: key, delivery: reference });
      }
      queueDelivery(message);
      refreshVisibleReads();
      continue;
    }
    if (processingMessageIds.has(key) || (failedMessageRetries.get(key) || 0) > Date.now()) continue;
    processingMessageIds.add(key);
    try {
      const payload = SidewordProtocol.decodePayload(await decryptMessage(message));
      if (payload.type === "attachment") throw new SidewordProtocol.ProtocolError("File bytes require the media channel.");
      if (payload.type === "attachment-ref" && payload.media_id !== `${message.client_message_id}.media`) {
        throw new SidewordProtocol.ProtocolError("Invalid attachment reference.");
      }
      const entry = {
        id: key,
        kind: "theirs",
        ...payloadEntry(payload),
        senderPublicId: message.sender_public_id,
        meta: `From ${message.sender_public_id}`,
        createdAt: serverTimestamp(message.created_at),
        delivery: deliveryReference(message, "sender_public_id"),
      };
      entry.meta = messageMeta(message.chat_id, entry);
      if (payload.type === "link-preview") {
        // Bound to the sender by construction: the target key includes this message's sender.
        Object.assign(entry, { kind: "link_preview", target: messageKey({ chat_id: message.chat_id,
          sender_public_id: message.sender_public_id, client_message_id: payload.target }) });
      }
      if (payload.type === "reaction") {
        // The reactor is the authenticated sender; the target resolves within this chat only.
        Object.assign(entry, { kind: "reaction", reactorPublicId: message.sender_public_id,
          target: reactionTargetKey(message.chat_id, payload.target_author, payload.target),
          emoji: payload.emoji, rev: payload.rev });
      }
      // A stale or repeated reaction changes nothing: the state superseding it is already saved.
      if (entry.kind !== "reaction" || supersedesReaction(entry,
        currentReaction(message.chat_id, entry.target, entry.reactorPublicId))) {
        await appendMessage(message.chat_id, entry);
      }
      seenMessageIds.add(key);
      failedMessageReasons.delete(key);
      failedMessageRetries.delete(key);
      queueDelivery(message);
    } catch (error) {
      const reason = errorMessage(error);
      if (error instanceof SidewordProtocol.ProtocolError) {
        if (failedMessageRetries.size >= 1024) {
          const oldest = failedMessageRetries.keys().next().value;
          failedMessageRetries.delete(oldest);
          failedMessageReasons.delete(oldest);
        }
        failedMessageRetries.set(key, Date.now() + 60000);
      }
      if (failedMessageReasons.get(key) !== reason) {
        failedMessageReasons.set(key, reason);
        appendMessage(message.chat_id, {
          kind: "system",
          text: `Message retained for retry: ${reason}`,
        }, false);
      }
    } finally {
      processingMessageIds.delete(key);
    }
  }
}

async function processReceipts(receipts, delivered = false) {
  for (const receipt of receipts) {
    const reference = deliveryReference(receipt, "reader_public_id");
    if (!/^[0-9a-f]{32}$/.test(receipt.message_delivery_id || "")) {
      throw new ClientError("The service returned incomplete confirmation information.");
    }
    if (!delivered && receipt.view_confirmed !== true) {
      throw new ClientError("The service returned an invalid viewing confirmation.");
    }
    const stage = delivered ? "delivered" : "read";
    const key = await messageEventId("receipt", [receipt.chat_id, receipt.reader_public_id,
      receipt.client_message_id, receipt.message_delivery_id, stage]);
    if (seenReceiptIds.has(key)) {
      pendingReceiptIds.set(receipt.delivery_id, reference);
      continue;
    }
    const entry = {
      id: key,
      kind: "receipt",
      receiptKind: stage,
      messageDeliveryId: receipt.message_delivery_id,
      readerPublicId: receipt.reader_public_id,
      clientMessageId: receipt.client_message_id,
      confirmedAt: receiptTime(receipt.created_at),
      createdAt: receiptTime(receipt.created_at) || Date.now(),
    };
    await appendMessage(receipt.chat_id, entry);
    seenReceiptIds.add(key);
    pendingReceiptIds.set(receipt.delivery_id, reference);
  }
}

async function processIncoming(data) {
  await processMessages(data.messages || []);
  // Unrelated receipt-storage failures must not retain already durable ciphertext.
  await flushDurableDeliveries();
  await processReceipts(data.delivery_receipts || [], true);
  await processReceipts(data.read_receipts || []);
  await flushAcknowledgements();
  scheduleMediaTransfers();
}

function stopMediaTransfers() {
  window.clearTimeout(mediaTimer);
  mediaTimer = null;
  transferController?.abort();
  mediaFailures.clear();
}

function scheduleMediaTransfers(delay = 0) {
  if (mediaTimer !== null || transferringMedia || !pageActive || !identity?.token || invitePending
      || globalThis.navigator?.onLine === false) return;
  mediaTimer = window.setTimeout(() => {
    mediaTimer = null;
    void transferMedia();
  }, delay);
}

function mediaAttempt(key, state = null) {
  const previous = mediaFailures.get(key) || state;
  if (previous?.attempts >= 6 || previous?.nextAt > Date.now()) return null;
  if (!previous && mediaFailures.size >= 1024) mediaFailures.delete(mediaFailures.keys().next().value);
  const attempt = { attempts: previous?.attempts || 0, active: true };
  mediaFailures.set(key, attempt);
  return attempt;
}

function mediaFailed(key, attempt) {
  attempt.active = false;
  attempt.attempts++;
  attempt.nextAt = Date.now() + Math.min(30000, 1000 * 2 ** attempt.attempts);
  mediaFailures.set(key, attempt);
}

async function transferMedia() {
  if (transferringMedia || !identity?.token || !pageActive || invitePending) return;
  transferringMedia = true;
  const owner = identity.publicId, publicKey = identity.publicKey, storageKey = identity.storageKey;
  const controller = new AbortController();
  transferController = controller;
  const current = () => !controller.signal.aborted && identity?.publicId === owner
    && identity?.publicKey === publicKey && identity?.token && pageActive;
  const options = { signal: controller.signal, priority: "low" };
  let retry = false;
  try {
    // One media request at a time; this lock is independent of text-message sending.
    await deviceLock(`media:${owner}`, async () => {
      const records = await readHistoryRecords(`mediaoutbox:${owner}:`);
      for (const stored of records) {
        if (!current()) return;
        const attempt = mediaAttempt(stored.key);
        if (!attempt) { retry ||= mediaFailures.get(stored.key)?.attempts < 6; continue; }
        let uploadKey;
        try {
          const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: stored.value.iv,
            additionalData: encoder.encode(stored.key) }, storageKey, stored.value.ciphertext);
          const record = JSON.parse(decoder.decode(plaintext));
          uploadKey = metadataKey(record.chatId, record.messageId.slice(0, -6));
          mediaUploadStates.set(uploadKey, "Sending media…");
          renderMessages();
          const chat = chats.find(chat => chat.id === record.chatId);
          if (!chat || chat.closed_at || record.expiresAt <= Date.now()) throw new ClientError("Media unavailable");
          const peers = record.recipients.map(id => chat.participants.find(peer => peer.public_id === id));
          for (const peer of peers) {
            if (!peer) throw new ClientError("Media participant unavailable");
            await assertTrustedPeer(peer);
          }
          if (!record.envelopes) {
            const payload = SidewordProtocol.encodePayload(record.payload);
            record.envelopes = [];
            for (const peer of peers) record.envelopes.push({ recipient_public_id: peer.public_id,
              ciphertext: await encryptForRecipient(payload, record.chatId, record.messageId, peer) });
            if (!current()) return;
            // Persist immutable ciphertext before upload; a lost response must retry identical bytes.
            await deviceLock(`outbox-capacity:${owner}`, async () => {
              const others = [...await readHistoryRecords(`mediaoutbox:${owner}:`),
                ...await readHistoryRecords(`outbox:${owner}:`)];
              const size = encoder.encode(JSON.stringify(record)).length + 16;
              if (others.filter(item => item.key !== stored.key)
                  .reduce((sum, item) => sum + item.value.ciphertext.byteLength, size) > 32 * 1024 * 1024) {
                throw new ClientError("Local media retry capacity reached");
              }
              if (current()) await persistOutbox(record, "mediaoutbox");
            });
          }
          if (!current()) return;
          await api(`/api/v1/chats/${record.chatId}/messages`, { ...options, method: "POST",
            body: JSON.stringify({ channel: "media", client_message_id: record.messageId, envelopes: record.envelopes }) });
          if (!current()) return;
          await removeOutbox(stored.key);
          mediaUploadStates.delete(uploadKey);
          mediaFailures.delete(stored.key);
          retry ||= records.length > 1;
        } catch { if (current()) {
          mediaFailed(stored.key, attempt);
          if (uploadKey && attempt.attempts >= 6) mediaUploadStates.set(uploadKey, "Could not send media");
          retry ||= attempt.attempts < 6;
        } }
        break; // Yield to message delivery between files, including group fanout.
      }
      for (const [chatId, entries] of messagesByChat) {
        if (!current()) return;
        if (chats.find(chat => chat.id === chatId)?.closed_at) continue;
        for (const entry of entries) {
          if (entry.kind !== "theirs" || entry.attachment?.type !== "attachment-ref") continue;
          const attempt = mediaAttempt(entry.id, entry.mediaTransfer);
          if (!attempt) { retry ||= (mediaFailures.get(entry.id) || entry.mediaTransfer)?.attempts < 6; continue; }
          entry.mediaTransfer = attempt;
          if (selectedChatId === chatId) renderMessages();
          try {
            const reference = entry.attachment;
            const message = await api(`/api/v1/chats/${chatId}/media/read`, { ...options, method: "POST",
              body: JSON.stringify({ sender_public_id: entry.senderPublicId, client_message_id: reference.media_id }) });
            if (!current()) return;
            if (message.chat_id !== chatId || message.sender_public_id !== entry.senderPublicId
                || message.client_message_id !== reference.media_id) throw new ClientError("Invalid media routing");
            const payload = SidewordProtocol.decodePayload(await decryptMessage(message));
            if (payload.type !== "attachment" || payload.name !== reference.name
                || payload.mime !== reference.mime || payload.size !== reference.size) throw new ClientError("Invalid media metadata");
            if (!current()) return;
            // Bytes authenticate and commit separately; metadata ACK has already completed.
            const saved = { id: `media_ready:${entry.id}`, kind: "media_ready", target: entry.id,
              attachment: payload, delivery: deliveryReference(message, "sender_public_id"), createdAt: Date.now() };
            if (await persistHistoryEntry(chatId, saved, current) === false || !current()) return;
            loadedHistoryKeys.add(historyKey(chatId, saved.id));
            await appendMessage(chatId, saved, false);
            mediaFailures.delete(entry.id);
            await flushDurableDeliveries();
          } catch { if (current()) { mediaFailed(entry.id, attempt); retry ||= attempt.attempts < 6; } }
          if (selectedChatId === chatId) renderMessages();
          retry = true;
          return;
        }
      }
    });
  } catch { retry = current(); } // Storage/network errors never escape into message rendering.
  finally {
    transferringMedia = false;
    transferController = null;
    if (current()) {
      renderMessages();
      if ([...mediaFailures.values()].some(failure => failure.attempts >= 6)) {
        try { await renderOutbox(); } catch { /* Durable retry data remains saved. */ }
      }
    }
    if (retry && current()) scheduleMediaTransfers(2000);
  }
}

async function synchronize({ initial = false } = {}) {
  if (!pageActive || globalThis.navigator?.onLine === false
      || invitePending || !identity?.token || synchronizing) return;
  synchronizing = true;
  try {
    await loadChats();
    await loadStoredHistory(); // Immutable encrypted events merge safely across tabs.
    if (initial) updateIdentityUi();
    try { await flushOutbox(); } catch (error) { showToast(errorMessage(error), true); }
    await renderOutbox();
    const data = await api("/api/v1/poll");
    await enqueueIncoming(() => processIncoming(data));
    await enqueueIncoming(recoverMessageStatuses);
    scheduleMediaTransfers();
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    synchronizing = false;
  }
}

function disconnectSocket() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  window.clearTimeout(socketAuthTimer);
  socketAuthTimer = null;
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  const previous = socket;
  socket = null;
  updateConnectionState(false);
  if (previous && previous.readyState <= WebSocket.OPEN) previous.close();
}

function scheduleReconnect() {
  if (!pageActive || globalThis.navigator?.onLine === false
      || invitePending || reconnectTimer || !identity?.token) return;
  const ceiling = Math.min(30000, 1000 * 2 ** reconnectAttempts);
  reconnectAttempts = Math.min(reconnectAttempts + 1, 5);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, Math.round(ceiling * (0.5 + Math.random() / 2)));
}

function retrySocket(ws) {
  if (socket !== ws) return;
  disconnectSocket();
  scheduleReconnect();
}

async function handleSocketPayload(payload, ws) {
  if (payload.type === "presence") {
    receivePresence(payload);
  } else if (payload.type === "auth_error") {
    clearPresence();
    if (identity?.refreshCredential) {
      await ensureFreshSession(true);
      connectSocket();
      return;
    }
    await invalidateSession("The saved session is no longer valid");
  } else if (payload.type === "hello") {
    await loadChats();
    if (socket !== ws) return;
    if (payload.user !== identity?.publicId) {
      throw new ClientError("The live connection and saved login identify different devices. Your local keys and history are kept.");
    }
    await processIncoming(payload.backlog || {});
    if (socket !== ws) return;
    reconnectAttempts = 0;
    updateConnectionState(true);
  } else if (payload.type === "chat_state") {
    await loadChats();
    await renderOutbox();
  } else if (payload.type === "message") {
    await processMessages([payload.message]);
    await flushAcknowledgements();
    scheduleMediaTransfers();
  } else if (payload.type === "read") {
    await processReceipts([payload.read]);
    await flushAcknowledgements();
  } else if (payload.type === "delivered") {
    await processReceipts([payload.delivery], true);
    await flushAcknowledgements();
  }
}

function connectSocket() {
  if (!pageActive || globalThis.navigator?.onLine === false
      || invitePending || !identity?.token || !identity.publicId
      || (socket && socket.readyState <= WebSocket.OPEN)) return;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  window.clearTimeout(socketAuthTimer);
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${window.location.host}/ws`, ["sideword.v1"]);
  const user = identity.publicId;
  const token = identity.token;
  clearPresence();
  socket = ws;
  socketAuthTimer = window.setTimeout(() => retrySocket(ws), 10000);
  ws.addEventListener("open", () => {
    if (socket !== ws || identity?.publicId !== user || identity?.token !== token) {
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ type: "auth", token, presence: true }));
    window.clearTimeout(socketAuthTimer);
    socketAuthTimer = window.setTimeout(() => retrySocket(ws), 7000);
    let lastResponse = performance.now();
    ws.addEventListener("message", () => { lastResponse = performance.now(); });
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = window.setInterval(() => {
      if (socket !== ws) return;
      if (performance.now() - lastResponse > 60000) {
        retrySocket(ws);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);
  });
  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    if (event.data === "pong") return;
    if (typeof event.data !== "string" || event.data.length > 4 * 1024 * 1024
        || queuedSocketBytes + event.data.length > 6 * 1024 * 1024 || queuedSocketEvents >= 32) {
      retrySocket(ws);
      return;
    }
    // Presence must not wait behind decryption, storage or HTTP work: doing so
    // could turn an old queued snapshot into an apparently fresh status.
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      clearPresence();
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    if (payload.type === "hello") {
      if (payload.user !== user || identity?.publicId !== user) {
        retrySocket(ws);
        showToast("The live connection authenticated a different device. Your local keys and history are kept.", true);
        return;
      }
      window.clearTimeout(socketAuthTimer);
      socketAuthTimer = null;
    }
    if (payload.type === "presence") {
      receivePresence(payload);
      return;
    }
    if (payload.type === "auth_error") clearPresence();
    const bytes = event.data.length;
    queuedSocketBytes += bytes;
    queuedSocketEvents++;
    enqueueIncoming(async () => {
        if (socket !== ws) return;
        try {
          await handleSocketPayload(payload, ws);
        } catch (error) {
          if (payload.type === "hello") retrySocket(ws);
          throw error;
        }
      })
      .catch((error) => showToast(errorMessage(error), true))
      .finally(() => { queuedSocketBytes -= bytes; queuedSocketEvents--; });
  });
  ws.addEventListener("close", () => retrySocket(ws));
  ws.addEventListener("error", () => retrySocket(ws));
}

const refresh = synchronize;

function showNameError() {
  const error = document.querySelector("#display-name-error");
  error.textContent = "Enter your name (1–64 characters).";
  error.style.color = "var(--danger)";
  error.hidden = false;
  elements.displayName.setAttribute("aria-invalid", "true");
  elements.displayName.focus();
}

elements.displayName.addEventListener("invalid", (event) => {
  event.preventDefault();
  showNameError();
});
elements.displayName.addEventListener("input", () => {
  document.querySelector("#display-name-error").hidden = true;
  elements.displayName.setAttribute("aria-invalid", "false");
});

async function prepareInviteResume(token) {
  identity.inviteCredentials ||= {};
  if (!identity.inviteCredentials[token]) {
    identity.inviteCredentials[token] = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Persist before sending: even a lost HTTP response must be safe to retry.
  await writeIdentity(identity);
  return identity.inviteCredentials[token];
}

elements.activationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.activationError.hidden = true;
  elements.roomPassword.setAttribute("aria-invalid", "false");
  const displayName = elements.displayName.value.trim();
  if (!displayName || displayName.length > 64) {
    showNameError();
    return;
  }
  const token = elements.inviteToken.value.trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
    showToast("The invite token is missing, incomplete, or contains invalid characters. The room has not been joined.", true);
    return;
  }
  const submitButton = elements.activationForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  try {
    if (!identity) identity = await generateIdentity();
    await ensureStorageKey();
    const resumeCredential = await prepareInviteResume(token);
    identity.activationCredentials ||= {};
    identity.activationCredentials[token] ||= randomCredential();
    await writeIdentity(identity);
    // Verify a separate read transaction before admission can consume a slot.
    await verifyIdentityPersistence();
    const sessionCredential = identity.activationCredentials[token];
    const previousPublicId = identity.publicId;
    const password = elements.roomPassword.value;
    elements.roomPassword.value = "";
    const result = await api("/api/v1/links/activate", {
      method: "POST",
      body: JSON.stringify({
        token,
        public_key: identity.publicKey,
        display_name: displayName,
        password: password || undefined,
        resume_credential: resumeCredential,
        session_credential: sessionCredential,
      }),
    });
    if (previousPublicId && previousPublicId !== result.user.public_id) {
      // Persisted history/outbox are scoped by public ID. Keep them for a later
      // reconnect; a new invite must never perform a destructive device reset.
      messagesByChat.clear();
      receivedMedia.clear(); receivedPreviews.clear(); reactionsByChat.clear();
      revealedImages.clear();
      mediaUploadStates.clear();
      seenMessageIds.clear();
      seenReceiptIds.clear();
      pendingReadsByChat.clear();
      pendingDeliveries.clear();
      if (elements.messageDetails.open) elements.messageDetails.close();
      messageMetadata.clear();
      loadedHistoryKeys.clear();
      deliveryReferences.clear();
      acknowledgedDeliveries.clear();
      acknowledgedReads.clear();
      outgoingAttempts.clear();
      messageProfileReady = false;
      visibleMessageNodes.clear();
      messageVisibilityObserver?.disconnect();
      for (const timer of viewTimers.values()) window.clearTimeout(timer);
      viewTimers.clear();
      pendingReceiptIds.clear();
      failedMessageReasons.clear();
    }
    identity.token = result.token;
    identity.refreshCredential = sessionCredential;
    identity.sessionId = result.session_id;
    identity.tokenExpiresAt = Date.parse(result.access_expires_at);
    identity.sessionExpiresAt = Date.parse(result.session_expires_at);
    delete identity.activationCredentials[token];
    delete identity.pendingRefreshCredential;
    identity.suspendedToken = null;
    identity.publicId = result.user.public_id;
    identity.activeInviteToken = token;
    identity.activeInviteChatId = result.chat.id;
    await writeIdentity(identity, true);
    selectedChatId = result.chat.id;
    invitePending = false;
    await loadStoredHistory();
    history.replaceState(null, "", "/client");
    updateIdentityUi();
    await refresh();
    connectSocket();
    elements.clientPanel.setAttribute("data-mobile-view", "conversation");
    selectChat(result.chat.id, mobileWorkspace());
    rememberChatView("conversation", result.chat.id);
    showToast("Invite activated. This device key is stored locally.");
  } catch (error) {
    elements.activationError.textContent = errorMessage(error);
    elements.activationError.hidden = false;
    elements.roomPassword.setAttribute("aria-invalid", "true");
    showToast(errorMessage(error), true);
  } finally {
    submitButton.disabled = false;
  }
});

// Picked emoji are inserted as plain text into the draft, so sending is unchanged.
const EMOJI_LIMIT_MESSAGE = "This emoji would make the message longer than the 16,000-byte limit.";
emojiPicker = globalThis.SidewordEmoji?.createPicker({
  toggle: elements.emojiButton, panel: elements.emojiPicker, input: elements.messageInput,
  search: document.querySelector("#emoji-search"), categories: document.querySelector("#emoji-categories"),
  grid: document.querySelector("#emoji-grid"), status: document.querySelector("#emoji-status"),
  maxBytes: SidewordProtocol.MAX_TEXT_BYTES,
  onLimit: () => composerError(EMOJI_LIMIT_MESSAGE),
  onInsert: () => { if (elements.composerError.textContent === EMOJI_LIMIT_MESSAGE) composerError(); },
});

elements.messageInput.addEventListener("input", event => {
  syncDraftLinkPreviews({ immediate: ["insertFromPaste", "insertFromDrop"].includes(event.inputType) });
});

// Keep focus in the composer when Send is tapped: on iOS a blur closes the keyboard,
// and the later programmatic focus cannot reopen it without a new user gesture.
elements.sendButton.addEventListener("mousedown", (event) => {
  if (document.activeElement === elements.messageInput) event.preventDefault();
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing
      || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  if (event.repeat || elements.messageInput.disabled || elements.sendButton.disabled) return;
  elements.messageForm.requestSubmit(elements.sendButton);
});

async function renderOutbox() {
  const panel = document.querySelector("#pending-sends");
  const list = document.querySelector("#pending-send-list");
  if (!panel || !identity?.publicId) return;
  const records = [...await readHistoryRecords(`outbox:${identity.publicId}:`),
    ...await readHistoryRecords(`mediaoutbox:${identity.publicId}:`)];
  const rows = [];
  for (const stored of records) {
    const row = document.createElement("li");
    try {
      const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv: stored.value.iv,
        additionalData: encoder.encode(stored.key) }, identity.storageKey, stored.value.ciphertext);
      const record = JSON.parse(decoder.decode(decoded));
      const state = chats.find(chat => chat.id === record.chatId)?.closed_at
        ? "Conversation closed" : record.expiresAt <= Date.now() ? "Send expired"
        : outgoingAttempts.get(metadataKey(record.chatId, record.messageId)) === "failed"
          || mediaFailures.get(stored.key)?.attempts >= 6 ? "Could not send" : null;
      if (!state) continue; // Normal background delivery needs no recovery panel.
      const payload = SidewordProtocol.validatePayload(record.payload);
      row.textContent = `${state}: ${payload.type === "text" ? payload.text
        : payload.type === "link-preview" ? "Link preview" : payload.type === "reaction" ? "Reaction"
          : "Attachment"} `;
    } catch { row.textContent = "Could not read a saved message. "; }
    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Remove saved send";
    discard.addEventListener("click", async () => {
      if (!window.confirm("Discard this saved retry? The message may already have reached the server. This cannot undo delivery.")) return;
      try {
        const lock = stored.key.startsWith("mediaoutbox:") ? "media" : "outbox";
        await deviceLock(`${lock}:${identity.publicId}`, () => removeOutbox(stored.key));
        await renderOutbox();
      } catch (error) { showToast(errorMessage(error), true); }
    });
    row.append(discard);
    rows.push(row);
  }
  list.replaceChildren(...rows);
  panel.hidden = rows.length === 0;
}

document.querySelector("#retry-pending-sends").addEventListener("click", () => {
  mediaFailures.clear();
  for (const entries of messagesByChat.values()) for (const entry of entries) entry.mediaTransfer = null;
  scheduleMediaTransfers();
  void synchronize();
});

async function persistOutbox(record, prefix = "outbox", removeKey = null) {
  if (!identity.storageKey) throw new ClientError("This device is missing the encryption key for its saved outgoing messages.");
  const key = `${prefix}:${identity.publicId}:${record.chatId}:${record.messageId}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(key) },
    identity.storageKey, encoder.encode(JSON.stringify(record)),
  );
  await putDatabaseValue(key, { iv, ciphertext }, removeKey);
}

async function removeOutbox(key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = transaction.onerror = () => {
      database.close(); reject(storageFailure(transaction.error, "The browser could not remove a saved outgoing retry from local storage."));
    };
  });
}

async function flushOutbox() {
  if (invitePending || !identity?.token) return;
  await deviceLock(`outbox:${identity.publicId}`, async () => {
    const records = await readHistoryRecords(`outbox:${identity.publicId}:`);
    for (const stored of records) {
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: stored.value.iv,
        additionalData: encoder.encode(stored.key) }, identity.storageKey, stored.value.ciphertext);
      const record = JSON.parse(decoder.decode(plaintext));
      if (SidewordProtocol.validatePayload(record.payload).type === "attachment") {
        throw new ClientError("This outgoing file requires a media reference.");
      }
      await storeOutgoing(record);
      if (chats.find(chat => chat.id === record.chatId)?.closed_at) continue;
      const attemptKey = metadataKey(record.chatId, record.messageId);
      outgoingAttempts.set(attemptKey, "sending");
      renderMessages();
      try {
        if (chats.find(chat => chat.id === record.chatId)?.participants.some(peer => peer.key_changed)) {
          throw new ClientError("A participant's encryption key changed. The saved send is paused; keep this device's history.");
        }
        if (record.expiresAt <= Date.now()) {
          throw new ClientError("An outgoing retry expired. The message is still saved locally; uploading it now could duplicate a message already delivered.");
        }
        const result = await api(`/api/v1/chats/${record.chatId}/messages`, {
          method: "POST", body: JSON.stringify({ client_message_id: record.messageId,
            envelopes: record.envelopes }),
        });
        await storeAcceptance(record.chatId, record.messageId, result);
        if (record.media) {
          await deviceLock(`outbox-capacity:${identity.publicId}`, () => persistOutbox({
            chatId: record.chatId, messageId: `${record.messageId}.media`,
            payload: record.media, recipients: record.envelopes.map(envelope => envelope.recipient_public_id),
            expiresAt: Math.min(record.expiresAt, receiptTime(result.content_expires_at) || record.expiresAt),
            createdAt: record.createdAt }, "mediaoutbox", stored.key));
          mediaUploadStates.set(metadataKey(record.chatId, record.messageId), "Sending media…");
        } else await removeOutbox(stored.key); // Acceptance/history commit before retry removal.
        outgoingAttempts.delete(attemptKey);
        scheduleMediaTransfers();
      } catch (error) {
        try {
          await appendMessage(record.chatId, { id: `send_failed:${record.messageId}`,
            kind: "send_failed", clientMessageId: record.messageId });
        } catch { /* Keep the original failure and the encrypted outbox retry. */ }
        outgoingAttempts.set(attemptKey, "failed");
        renderMessages();
        throw error;
      }
    }
  });
}

async function storeOutgoing(record) {
  const entry = { id: `outgoing:${record.messageId}`, kind: "mine",
    clientMessageId: record.messageId,
    recipients: record.envelopes.map(envelope => envelope.recipient_public_id),
    senderPublicId: identity.publicId,
    ...payloadEntry(SidewordProtocol.validatePayload(record.payload)), meta: `Sent by ${identity.publicId}`,
    createdAt: record.createdAt };
  entry.meta = messageMeta(record.chatId, entry);
  if (record.media) entry.attachment = SidewordProtocol.validatePayload(record.media);
  if (record.payload.type === "link-preview") Object.assign(entry, { kind: "link_preview", target: `outgoing:${record.payload.target}` });
  if (record.payload.type === "reaction") {
    Object.assign(entry, { kind: "reaction", reactorPublicId: identity.publicId,
      target: reactionTargetKey(record.chatId, record.payload.target_author, record.payload.target),
      emoji: record.payload.emoji, rev: record.payload.rev });
  }
  await appendMessage(record.chatId, entry);
}

async function storeAcceptance(chatId, messageId, result) {
  const key = await messageEventId("acceptance", [messageId,
    [...(result.recipients || [])].sort(), Object.entries(result.deliveries || {}).sort(),
    result.content_expires_at || null]);
  await appendMessage(chatId, { id: key, kind: "acceptance",
    clientMessageId: messageId, recipients: result.recipients,
    deliveries: result.deliveries || {}, contentExpiresAt: receiptTime(result.content_expires_at), createdAt: receiptTime(result.created_at) || Date.now() });
}

async function recoverMessageStatuses() {
  if (!messageProfileReady || !identity?.receiptRetentionSeconds || !selectedChatId
      || chats.find(chat => chat.id === selectedChatId)?.closed_at) return;
  const entries = (messagesByChat.get(selectedChatId) || []).filter(entry => entry.kind === "mine"
    && Date.now() - historyTimestamp(entry) < identity.receiptRetentionSeconds * 1000
    && !outgoingStatus(selectedChatId, entry).allRead);
  if (!entries.length) return;
  const start = statusPollCursor % entries.length;
  const batch = [...entries.slice(start), ...entries.slice(0, start)].slice(0, 100);
  statusPollCursor += batch.length;
  const chatId = selectedChatId;
  const result = await api(`/api/v1/chats/${chatId}/messages/status`, { method: "POST",
    body: JSON.stringify({ client_message_ids: batch.map(outgoingMessageId) }) });
  for (const message of result.statuses || []) {
    await storeAcceptance(chatId, message.client_message_id, { created_at: message.created_at,
      content_expires_at: message.content_expires_at,
      recipients: message.recipients.map(peer => peer.public_id),
      deliveries: Object.fromEntries(message.recipients.filter(peer => peer.delivery_id)
        .map(peer => [peer.public_id, peer.delivery_id])) });
    for (const peer of message.recipients) {
      if (["expired", "unavailable"].includes(peer.state) && peer.delivery_id) {
        const key = await messageEventId("delivery_state", [chatId, message.client_message_id,
          peer.public_id, peer.delivery_id, peer.state]);
        await appendMessage(chatId, { id: key, kind: "delivery_state",
          clientMessageId: message.client_message_id, recipient: peer.public_id,
          deliveryId: peer.delivery_id, state: peer.state, createdAt: Date.now() });
      }
      for (const [stage, time] of [["delivered", peer.delivered_at], ["read", peer.read_at]]) {
        if (!time) continue;
        const key = await messageEventId("receipt", [chatId, peer.public_id,
          message.client_message_id, peer.delivery_id || null, stage]);
        await appendMessage(chatId, { id: key, kind: "receipt",
          receiptKind: stage, readerPublicId: peer.public_id,
          clientMessageId: message.client_message_id, messageDeliveryId: peer.delivery_id || null,
          confirmedAt: receiptTime(time), createdAt: receiptTime(time) || Date.now() });
      }
    }
  }
}

function payloadEntry(payload) {
  if (payload.type === "attachment" || payload.type === "attachment-ref") return { attachment: payload, text: payload.text || "" };
  if (payload.type === "link-preview") return { preview: payload.preview };
  if (payload.type === "reaction") return {};
  return payload.preview ? { text: payload.text, preview: payload.preview } : { text: payload.text };
}

function fileIcon() {
  // Fixed decorative geometry only; file content and MIME never enter the DOM.
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", focusable: "false", class: "file-icon"})) {
    icon.setAttribute(name, value);
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6 M8 13h8 M8 17h5");
  icon.append(path);
  return icon;
}

function downloadIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round",
    "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false"})) {
    icon.setAttribute(name, value);
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 3v12 m-5-5 5 5 5-5 M5 16v4h14v-4");
  icon.append(path);
  return icon;
}

function fileSize(size) {
  return size === 1048576 ? "1 MiB" : size > 1048576 ? `${(size / 1048576).toFixed(1)} MiB`
    : size >= 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${size} B`;
}

function composerError(message = "") {
  elements.composerError.textContent = message;
  elements.composerError.hidden = !message;
}

function clearAttachment() {
  selectedFile = null;
  composerPreview.token++;
  composerPreview.optimizing = false;
  releaseComposerImage();
  elements.attachmentTile.classList.toggle("media-loading", false);
  elements.attachmentInput.value = "";
  elements.attachmentPreview.hidden = true;
  elements.attachmentLabel.textContent = "";
  elements.attachmentSize.textContent = "";
}

function releaseComposerImage() {
  elements.attachmentTile.classList.toggle("has-thumbnail", false);
  if (composerPreview.image) {
    composerPreview.image.removeAttribute("src");
    composerPreview.image.remove();
    composerPreview.image = null;
  }
  if (composerPreview.url) { URL.revokeObjectURL(composerPreview.url); composerPreview.url = null; }
}

// Largest file that fits the per-recipient encrypted request budget for this chat.
function sendableFileBytes(chatId) {
  const chat = chats.find(candidate => candidate.id === chatId);
  const recipients = chat?.participants.filter(item => item.public_id !== identity?.publicId).length || 0;
  let low = 0, high = SidewordProtocol.MAX_FILE_BYTES;
  if (!recipients) return high;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (SidewordProtocol.attachmentSendBytes(middle, recipients) <= SidewordProtocol.MAX_SEND_BYTES) low = middle;
    else high = middle - 1;
  }
  return low;
}

// Local review only: reads after size and peer-trust checks, never uploads. Oversized
// images, such as browser-copied PNGs, are re-encoded as smaller JPEGs before Send.
async function prepareSelectedImage(file, chatId) {
  const token = composerPreview.token;
  let staged = file;
  const current = () => token === composerPreview.token && selectedFile === staged && selectedChatId === chatId;
  if (!globalThis.SidewordMedia || !IMAGE_TYPES.includes(file.type.toLowerCase())) return;
  const optimize = composerPreview.optimizing;
  let shown = false, failure = null;
  elements.attachmentTile.classList.toggle("media-loading", true);
  if (!optimize) elements.attachmentSize.textContent = `${fileSize(file.size)} · Preparing image preview…`;
  try {
    const chat = chats.find(candidate => candidate.id === chatId);
    const recipients = chat?.participants.filter(item => item.public_id !== identity.publicId) || [];
    if (!recipients.length) throw new ClientError("This conversation has no recipients.");
    for (const recipient of recipients) await assertTrustedPeer(recipient);
    if (!current()) return;
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (!current()) return;
    if (optimize) {
      bytes = await SidewordMedia.reduceImage(bytes, file.type, sendableFileBytes(chatId), current);
      if (!current()) return;
      if (!bytes) throw new ClientError("This image could not be reduced below the send limit. Choose a smaller image.");
      const name = `${file.name.replace(/\.[^.]*$/, "").slice(0, 200) || "image"}.jpg`;
      staged = new File([bytes], name, { type: "image/jpeg" });
      selectedFile = staged;
      composerPreview.optimizing = false;
      elements.attachmentLabel.textContent = SidewordProtocol.safeDownloadName(name);
      elements.attachmentLabel.title = elements.attachmentLabel.textContent;
      selectChat(chatId);
    }
    const prepared = SidewordMedia.previewBlob(bytes, staged.type);
    const image = document.createElement("img");
    if (!prepared || typeof image.decode !== "function") return;
    image.alt = "";
    image.className = "attachment-thumb";
    image.decoding = "async";
    image.draggable = false;
    composerPreview.image = image;
    composerPreview.url = URL.createObjectURL(prepared.blob);
    image.src = composerPreview.url;
    await image.decode();
    if (!current() || !SidewordMedia.decodedMatches(image, prepared.info)) return;
    elements.attachmentTile.append(image);
    elements.attachmentTile.classList.toggle("has-thumbnail", true);
    shown = true;
  } catch (error) { failure = error; }
  finally {
    if (current()) finishSelectedImage(file, staged, shown, failure);
  }
}

function finishSelectedImage(original, staged, shown, failure) {
  elements.attachmentTile.classList.toggle("media-loading", false);
  if (composerPreview.optimizing) {
    // An oversized image cannot be sent unchanged, so remove it and explain why.
    clearAttachment();
    composerError(failure instanceof ClientError ? failure.message
      : "This image could not be reduced below the send limit. Choose a smaller image.");
    selectChat(selectedChatId);
    return;
  }
  if (!shown) releaseComposerImage();
  const note = staged !== original ? `Optimized from ${fileSize(original.size)}`
    : shown ? "Image attachment" : "Image preview unavailable";
  elements.attachmentSize.textContent = `${fileSize(staged.size)} · ${note}`;
}

function selectAttachment(file) {
  clearAttachment();
  composerError();
  if (!file) return;
  const image = IMAGE_TYPES.includes(file.type.toLowerCase());
  const optimize = Boolean(image && globalThis.SidewordMedia && file.size > sendableFileBytes(selectedChatId));
  if (optimize && file.size > SidewordMedia.MAX_SOURCE_BYTES) {
    throw new ClientError("Images must be 20 MiB or smaller to be reduced for sending.");
  }
  if (!optimize && file.size > SidewordProtocol.MAX_FILE_BYTES) {
    throw new ClientError("Files must be 1 MiB (1,048,576 bytes) or smaller.");
  }
  if (!file.name || file.name.length > 255 || file.type.length > 127) {
    throw new ClientError("The filename or declared file type is too long.");
  }
  selectedFile = file;
  composerPreview.optimizing = optimize;
  elements.attachmentLabel.textContent = SidewordProtocol.safeDownloadName(file.name);
  elements.attachmentLabel.title = elements.attachmentLabel.textContent;
  elements.attachmentSize.textContent = optimize ? `${fileSize(file.size)} · Reducing image for sending…`
    : `${fileSize(file.size)} · ${image ? "Image" : "File"} attachment`;
  elements.attachmentPreview.hidden = false;
  // Keep the text composer available for an optional message above the media.
}

function stageAttachmentFiles(files) {
  if (sendingMessage || elements.attachmentButton.disabled) {
    composerError(sendingMessage ? "Wait for the current message to finish sending."
      : "File attachment is unavailable. Select an active conversation and resolve any access or key warnings.");
    return;
  }
  if (files.length !== 1) {
    composerError(files.length ? "Attach one file at a time. Choose a single file."
      : "No file was available. Copy or drag a file, or use the attachment button.");
    return;
  }
  try { selectAttachment(files[0]); }
  catch (error) { composerError(errorMessage(error)); }
  selectChat(selectedChatId);
  if (selectedFile) void prepareSelectedImage(selectedFile, selectedChatId);
  if (selectedFile && !elements.sendButton.disabled) elements.sendButton.focus();
}

function hasTransferFiles(transfer) {
  return Boolean(transfer?.files?.length || Array.from(transfer?.types || []).includes("Files"));
}

elements.attachmentButton.addEventListener("click", () => elements.attachmentInput.click());
elements.attachmentInput.addEventListener("change", () => {
  if (sendingMessage || !elements.attachmentInput.files?.[0]) return;
  stageAttachmentFiles(elements.attachmentInput.files);
});
// Read only files supplied by the user's paste/drop event. Never read clipboard
// permissions, HTML, remote URLs or file contents here; sending owns file reads.
elements.conversation.addEventListener("paste", event => {
  if (!hasTransferFiles(event.clipboardData)) return; // Preserve ordinary text paste.
  event.preventDefault();
  stageAttachmentFiles(event.clipboardData.files || []);
});
elements.conversation.addEventListener("dragover", event => {
  if (!hasTransferFiles(event.dataTransfer)) return;
  event.preventDefault(); // Prevent browser navigation, including when sending is blocked.
  event.dataTransfer.dropEffect = !sendingMessage && !elements.attachmentButton.disabled ? "copy" : "none";
  elements.conversation.classList.toggle("file-drag-over", event.dataTransfer.dropEffect === "copy");
});
elements.conversation.addEventListener("dragleave", event => {
  if (event.relatedTarget && elements.conversation.contains(event.relatedTarget)) return;
  elements.conversation.classList.toggle("file-drag-over", false);
});
elements.conversation.addEventListener("dragend", () => elements.conversation.classList.toggle("file-drag-over", false));
elements.conversation.addEventListener("drop", event => {
  elements.conversation.classList.toggle("file-drag-over", false);
  if (!hasTransferFiles(event.dataTransfer)) return;
  event.preventDefault();
  stageAttachmentFiles(event.dataTransfer.files || []);
});
elements.attachmentCancel.addEventListener("click", () => {
  if (sendingMessage) return;
  clearAttachment();
  composerError();
  selectChat(selectedChatId);
  if (!elements.messageInput.disabled) elements.messageInput.focus();
});

function releaseDownload(url) {
  if (!downloadUrls.has(url)) return;
  window.clearTimeout(downloadUrls.get(url));
  URL.revokeObjectURL(url);
  downloadUrls.delete(url);
}

function downloadAttachment(payload, errorNode) {
  let url;
  let link;
  try {
    errorNode.textContent = "";
    SidewordProtocol.validatePayload(payload);
    if (downloadUrls.size >= 8) throw new ClientError("Please wait before starting another download.");
    const bytes = SidewordProtocol.attachmentBytes(payload);
    url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    downloadUrls.set(url, null);
    link = document.createElement("a");
    link.href = url;
    link.download = SidewordProtocol.safeDownloadName(payload.name);
    link.hidden = true;
    document.body.append(link);
    link.click();
    // Keep the URL alive for navigation/download handoff, including slower engines.
    downloadUrls.set(url, window.setTimeout(() => releaseDownload(url), 60000));
  } catch (error) {
    if (url) releaseDownload(url);
    errorNode.textContent = error instanceof ClientError ? error.message
      : "The file could not be downloaded. Its saved copy is retained; try again.";
  } finally { link?.remove(); }
}

elements.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  const chat = chats.find((candidate) => candidate.id === selectedChatId);
  const file = selectedFile;
  if (sendingMessage || composerPreview.optimizing || (!text && !file) || !chat || chat.closed_at) return;
  sendingMessage = true;
  elements.sendButton.disabled = true;
  elements.attachmentButton.disabled = true;
  elements.attachmentInput.disabled = true;
  elements.attachmentCancel.disabled = true;
  elements.sendButton.textContent = "Sending…";
  composerError();
  try {
    const messageId = crypto.randomUUID();
    const recipients = chat.participants.filter((item) => item.public_id !== identity.publicId);
    if (!recipients.length || recipients.length > 100) throw new ClientError("This conversation exceeds the recipient limit or has no peers.");
    // Verify every peer before reading the file or starting expensive encryption.
    for (const recipient of recipients) await assertTrustedPeer(recipient);
    if (file && (file.size > SidewordProtocol.MAX_FILE_BYTES
        || SidewordProtocol.attachmentSendBytes(file.size, recipients.length) > SidewordProtocol.MAX_SEND_BYTES)) {
      throw new ClientError("This file exceeds the file or group transport limit. Use a smaller file or fewer recipients.");
    }
    const payload = file ? SidewordProtocol.fileReference(file.name, file.type, file.size, `${messageId}.media`, text)
      : textPayloadWithPreview(text, recipients.length);
    await queueEncryptedMessage(chat, recipients, messageId, payload, { file, onQueued: () => {
      // Ownership transfers to the durable outbox even if subsequent history persistence fails.
      if (file) clearAttachment();
      window.clearTimeout(draftPrefetchTimer);
      elements.messageInput.value = "";
    } });
    // Not ready yet: the preview follows in its own encrypted message once loaded.
    if (!file && !payload.preview) followUpLinkPreview(chat.id, messageId, text, recipients);
    try { await flushOutbox(); }
    finally { await renderOutbox(); }
  } catch (error) {
    composerError(errorMessage(error));
  } finally {
    sendingMessage = false;
    elements.attachmentCancel.disabled = false;
    selectChat(selectedChatId);
    if (!elements.messageInput.disabled) elements.messageInput.focus({ preventScroll: true });
  }
});

// Encrypts one payload per recipient, checks transport limits and stores it in the durable
// encrypted outbox. onQueued runs once the outbox owns the message.
async function queueEncryptedMessage(chat, recipients, messageId, payload, { file = null, onQueued = null } = {}) {
  const plaintext = SidewordProtocol.encodePayload(payload);
  const envelopes = [];
  let wireBytes = 512;
  // Sequential encryption bounds transient buffers independently of group size.
  for (const recipient of recipients) {
    const ciphertext = await encryptForRecipient(plaintext, chat.id, messageId, recipient);
    wireBytes += ciphertext.length + 512;
    if (wireBytes > SidewordProtocol.MAX_SEND_BYTES) throw new ClientError("This message exceeds the group transport limit.");
    envelopes.push({ recipient_public_id: recipient.public_id, ciphertext });
  }
  if (encoder.encode(JSON.stringify({ client_message_id: messageId, envelopes })).length > SidewordProtocol.MAX_SEND_BYTES) {
    throw new ClientError("This message exceeds the group transport limit. Use a smaller message or fewer recipients.");
  }
  if (!identity.retryWindowSeconds) throw new ClientError("The server does not advertise a safe message retry period. This message was not uploaded.");
  const record = { chatId: chat.id, messageId, envelopes, payload,
    expiresAt: Date.now() + Math.max(0, identity.retryWindowSeconds - 300) * 1000,
    createdAt: Date.now() };
  if (file) record.media = SidewordProtocol.filePayload(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
  await deviceLock(`outbox:${identity.publicId}`, async () => {
    await deviceLock(`outbox-capacity:${identity.publicId}`, async () => {
      const records = [...await readHistoryRecords(`outbox:${identity.publicId}:`),
        ...await readHistoryRecords(`mediaoutbox:${identity.publicId}:`)];
      const bytes = records.reduce((sum, item) => sum + item.value.ciphertext.byteLength, 0);
      if (records.length >= 100 || bytes + encoder.encode(JSON.stringify(record)).length + 16
          > (file ? 16 : 32) * 1024 * 1024) {
        throw new ClientError("The encrypted local outbox is full. Retry or discard pending sends before adding another message.");
      }
      await persistOutbox(record);
    });
    onQueued?.();
    await storeOutgoing(record);
  });
  return record;
}

elements.refreshButton.addEventListener("click", refresh);
document.querySelector("#reconnect-session").addEventListener("click", async (event) => {
  if (invitePending || !identity?.suspendedToken) return;
  event.target.disabled = true;
  identity.token = identity.suspendedToken;
  try {
    await loadChats();
    identity.suspendedToken = null;
    await writeIdentity(identity);
    updateIdentityUi();
    connectSocket();
    await synchronize();
  } catch (error) {
    identity.token = null;
    await writeIdentity(identity);
    updateIdentityUi();
    showToast(errorMessage(error), true);
  } finally {
    event.target.disabled = false;
  }
});
elements.resetButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Remove this browser's private key and session? Existing chats cannot be recovered on this device.",
  );
  if (!confirmed) return;
  try {
    await clearIdentity();
    globalThis.SidewordEmoji?.forgetRecent();
    window.location.assign("/client");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
});

async function start() {
  if (!window.isSecureContext) throw new ClientError("This page is not running in a secure browser context. Chat requires HTTPS or localhost.");
  if (!window.crypto?.subtle) throw new ClientError("The browser's encryption features are unavailable, so this client cannot create or use chat keys.");
  if (!window.indexedDB) throw new ClientError("The browser's local database is unavailable, so this client cannot save device keys or chat history.");
  identity = await readIdentity();
  scrubInviteFromUrl();
  const requestedInvite = (elements.inviteToken.value || "").trim();
  invitePending = Boolean(requestedInvite && requestedInvite !== identity?.activeInviteToken);
  if (!invitePending) restoreChatView();
  await ensureStorageKey();
  if (!invitePending) await loadStoredHistory();
  if (!invitePending && identity?.token) {
    await refresh({ initial: true });
  }
  // Apply the first chat snapshot before revealing the workspace. Failed refreshes
  // still reveal saved local history.
  if (!elements.loadingPanel.hidden) updateIdentityUi();
  if (!invitePending && selectedChatId) renderMessages(true);
  if (!invitePending && identity?.token) connectSocket();
  window.setInterval(synchronize, POLL_INTERVAL_MS);
  window.setInterval(checkAccessExpiry, 1000);
}

// The invite credential stays in the server-filled form only: remove it from the address bar
// and this session-history entry so it is not kept in history, bookmarks or screenshots.
function scrubInviteFromUrl() {
  const search = window.location?.search;
  if (!search || !new URLSearchParams(search).has("invite")) return;
  history.replaceState(history.state, "", window.location.pathname);
}

// Access tokens renew automatically; only an actually expired session is surfaced.
function checkAccessExpiry() {
  if (invitePending || !identity?.token || accessDeadline === null) return;
  if (accessDeadline - performance.now() <= 0) {
    accessDeadline = null;
    void invalidateSession("Session expired").catch(error => showToast(errorMessage(error), true));
  }
}

window.addEventListener("online", () => {
  connectSocket();
  void synchronize();
});
window.addEventListener("offline", disconnectSocket);
window.addEventListener("pagehide", () => {
  mediaPreviews?.clear();
  releaseAllLinkPreviews();
  if (elements.imageViewer.open) elements.imageViewer.close();
  stopMediaTransfers();
  for (const url of downloadUrls.keys()) releaseDownload(url);
  pageActive = false;
  disconnectSocket();
});
window.addEventListener("pageshow", (event) => {
  pageActive = true;
  scheduleVisiblePreviews();
  keepScrollPosition(() => { for (const node of renderedMessages.values()) updateLinkPreview(node); });
  if (event.persisted) {
    connectSocket();
    void synchronize();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") mediaPreviews?.clear();
  refreshVisibleReads();
  if (document.visibilityState === "visible") {
    scheduleVisiblePreviews();
    // Timers can be suspended in background tabs. Expired leases remain unknown
    // until a fresh snapshot arrives; request one on the existing socket.
    renderPresence();
    if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
    connectSocket();
    void synchronize();
  }
});
window.addEventListener("focus", refreshVisibleReads);
window.addEventListener("blur", () => {
  for (const timer of viewTimers.values()) window.clearTimeout(timer);
  viewTimers.clear();
});
window.addEventListener("resize", () => {
  scheduleVisiblePreviews();
  if (elements.imageViewer.open) layoutImageViewer();
  refreshVisibleReads();
  positionMessageDetails();
});

function showStartupError(error) {
  elements.loadingPanel.hidden = true;
  elements.setupPanel.hidden = false;
  elements.clientPanel.hidden = true;
  elements.activationError.textContent = errorMessage(error);
  elements.activationError.hidden = false;
  showToast(errorMessage(error), true);
}

applyImagePreviewMode(imagePreviewMode);
start().catch(showStartupError);
