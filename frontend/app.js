const API_BASE = "";

let notebooks = [];
let activeNotebookId = null;
let isWaitingForResponse = false;

const appContainer   = document.getElementById("app-container");
const themeToggle    = document.getElementById("theme-toggle");
const moonIcon       = document.getElementById("moon-icon");
const sunIcon        = document.getElementById("sun-icon");
const uploadBtn      = document.getElementById("upload-btn");
const fileInput      = document.getElementById("file-input");
const uploadStatus   = document.getElementById("upload-status");
const fileListEl     = document.getElementById("file-list");
const activeFileName = document.getElementById("active-file-name");
const chatMessages   = document.getElementById("chat-messages");
const chatForm       = document.getElementById("chat-form");
const chatInput      = document.getElementById("chat-input");
const sendBtn        = document.getElementById("send-btn");


let isDark = true;

themeToggle.addEventListener("click", () => {
  isDark = !isDark;
  if (isDark) {
    appContainer.parentElement.classList.remove("light-theme");
    appContainer.parentElement.classList.add("dark-theme");
    moonIcon.style.display = "block";
    sunIcon.style.display = "none";
  } else {
    appContainer.parentElement.classList.remove("dark-theme");
    appContainer.parentElement.classList.add("light-theme");
    moonIcon.style.display = "none";
    sunIcon.style.display = "block";
  }
});


uploadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  fileInput.value = ""; 

  uploadBtn.disabled = true;
  uploadBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
    Indexing...
  `;

  showStatus("Uploading & indexing document...", "");
  showProgressBar(true);

  try {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`${API_BASE}/api/upload`, {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || data.details || "Upload failed");
    }


    const ext = file.name.split(".").pop().toLowerCase();
    const notebook = {
      id: Date.now().toString(),
      name: file.name,
      collectionName: data.collectionName,
      ext: ext,
      addedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      messages: [],
    };

    notebooks.unshift(notebook);
    renderFileList();
    switchNotebook(notebook.id);

    showStatus(`✓ "${file.name}" is ready!`, "success");
  } catch (err) {
    showStatus(`✗ ${err.message}`, "error");
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
      Upload Document
    `;
    showProgressBar(false);
    setTimeout(() => hideStatus(), 4000);
  }
});

function showStatus(msg, type) {
  uploadStatus.className = `status-text ${type}`;
  uploadStatus.textContent = msg;
  uploadStatus.classList.remove("hidden");
}

function hideStatus() { uploadStatus.classList.add("hidden"); }

function showProgressBar(show) {
  let bar = document.getElementById("progress-bar-wrapper");
  if (show) {
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "progress-bar-wrapper";
      bar.className = "progress-bar-wrapper";
      bar.innerHTML = `<div class="progress-bar"></div>`;
      uploadStatus.after(bar);
    }
    bar.style.display = "block";
  } else {
    if (bar) bar.style.display = "none";
  }
}


function getFileIcon(ext) {
  const icons = { pdf: "📄", csv: "📊", txt: "📝" };
  return icons[ext] || "📁";
}

function renderFileList() {
  fileListEl.innerHTML = "";

  if (notebooks.length === 0) {
    fileListEl.innerHTML = `<div class="empty-state">No notebooks yet. Upload a file to start!</div>`;
    return;
  }

  notebooks.forEach((nb) => {
    const li = document.createElement("li");
    li.className = `file-item${activeNotebookId === nb.id ? " active" : ""}`;
    li.dataset.id = nb.id;
    li.innerHTML = `
      <div class="file-icon ${nb.ext}">${getFileIcon(nb.ext)}</div>
      <div class="file-info">
        <div class="file-name" title="${nb.name}">${nb.name}</div>
        <div class="file-date">Added at ${nb.addedAt}</div>
      </div>
    `;
    li.addEventListener("click", () => switchNotebook(nb.id));
    fileListEl.appendChild(li);
  });
}

function switchNotebook(id) {
  activeNotebookId = id;
  const nb = notebooks.find((n) => n.id === id);
  if (!nb) return;

  activeFileName.textContent = `💬  ${nb.name}`;

  chatInput.disabled = false;
  sendBtn.disabled = false;
  chatInput.placeholder = `Ask a question about "${nb.name}"...`;

  renderMessages(nb);

  document.querySelectorAll(".file-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });

  chatInput.focus();
}


function renderMessages(nb) {
  chatMessages.innerHTML = "";

  if (nb.messages.length === 0) {
    chatMessages.innerHTML = `
      <div class="welcome-screen">
        <div class="glow-orb"></div>
        <h2>Notebook Ready</h2>
        <p>Your document <strong>"${nb.name}"</strong> is indexed. Ask me anything about it!</p>
      </div>
    `;
    return;
  }

  nb.messages.forEach((msg) => appendMessageDOM(msg.role, msg.content, false, msg.trace));
  scrollToBottom();
}

function renderTrace(trace) {
  if (!trace || !trace.length) return "";
  const steps = trace
    .map(
      (t) =>
        `<div class="trace-step"><span class="trace-tag">${escapeHTML(t.step)}</span>${escapeHTML(t.detail)}</div>`
    )
    .join("");
  return `
    <details class="rag-trace">
      <summary>🔍 Corrective RAG trace (${trace.length} steps)</summary>
      ${steps}
    </details>
  `;
}

function appendMessageDOM(role, content, animate = true, trace = null) {
  const welcome = chatMessages.querySelector(".welcome-screen");
  if (welcome) welcome.remove();

  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  if (!animate) row.style.animation = "none";

  const avatarText = role === "user" ? "U" : "✦";
  row.innerHTML = `
    <div class="avatar">${avatarText}</div>
    <div class="bubble">${escapeHTML(content)}${role === "ai" ? renderTrace(trace) : ""}</div>
  `;

  chatMessages.appendChild(row);
  if (animate) scrollToBottom();
  return row;
}

function appendThinkingDots() {
  const welcome = chatMessages.querySelector(".welcome-screen");
  if (welcome) welcome.remove();

  const row = document.createElement("div");
  row.className = "message-row ai";
  row.id = "thinking-row";
  row.innerHTML = `
    <div class="avatar">✦</div>
    <div class="bubble thinking-dots"><span></span><span></span><span></span></div>
  `;
  chatMessages.appendChild(row);
  scrollToBottom();
}

function removeThinkingDots() {
  const row = document.getElementById("thinking-row");
  if (row) row.remove();
}

function scrollToBottom() {
  chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: "smooth" });
}

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const query = chatInput.value.trim();
  if (!query || isWaitingForResponse || !activeNotebookId) return;

  const nb = notebooks.find((n) => n.id === activeNotebookId);
  if (!nb) return;

  isWaitingForResponse = true;
  chatInput.value = "";
  sendBtn.disabled = true;
  chatInput.disabled = true;

  nb.messages.push({ role: "user", content: query });
  appendMessageDOM("user", query);

  appendThinkingDots();

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, collectionName: nb.collectionName }),
    });

    const data = await res.json();
    removeThinkingDots();

    if (res.status === 429) {
      const msg = data.error || "Rate limit reached. Please wait a minute and try again.";
      nb.messages.push({ role: "ai", content: msg });
      appendMessageDOM("ai", msg);
      return;
    }

    if (!res.ok || !data.success) {
      throw new Error(data.error || data.details || "Unknown error");
    }

    const answer = data.answer || "I could not find an answer in the document.";
    nb.messages.push({ role: "ai", content: answer, trace: data.trace });
    appendMessageDOM("ai", answer, true, data.trace);
  } catch (err) {
    removeThinkingDots();
    const errMsg = `Error: ${err.message}`;
    nb.messages.push({ role: "ai", content: errMsg });
    appendMessageDOM("ai", errMsg);
  } finally {
    isWaitingForResponse = false;
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
});
