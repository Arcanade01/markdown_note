const elements = {
  workspace: document.getElementById("workspace"),
  loadButton: document.getElementById("loadButton"),
  toggleViewerButton: document.getElementById("toggleViewerButton"),
  folderStatus: document.getElementById("folderStatus"),
  saveStatus: document.getElementById("saveStatus"),
  treeList: document.getElementById("treeList"),
  tocList: document.getElementById("tocList"),
  editor: document.getElementById("editor"),
  preview: document.getElementById("preview"),
  newCategoryButton: document.getElementById("newCategoryButton"),
  newPageButton: document.getElementById("newPageButton"),
  renameButton: document.getElementById("renameButton"),
  deleteButton: document.getElementById("deleteButton"),
  dialogBackdrop: document.getElementById("dialogBackdrop"),
  dialog: document.getElementById("dialog"),
  dialogTitle: document.getElementById("dialogTitle"),
  dialogMessage: document.getElementById("dialogMessage"),
  dialogInput: document.getElementById("dialogInput"),
  dialogConfirmButton: document.getElementById("dialogConfirmButton"),
  dialogCancelButton: document.getElementById("dialogCancelButton"),
  dialogCloseButton: document.getElementById("dialogCloseButton")
};

let rootHandle = null;
let treeRoot = null;
let selectedNode = null;
let selectedPageNode = null;
let saveTimer = null;
let saveState = "idle";
let headings = [];
let activeHeadingId = "";
let renderSequence = 0;
let previewSourceElements = [];
let dialogResolver = null;
let suppressEditorScroll = false;
let suppressPreviewScroll = false;
let viewerOnly = false;
let headingHighlightTimer = null;
let draggingTreePath = null;
let editorLineMetricsCache = null;

const expandedPaths = new Set([""]);
const objectUrls = new Map();
const EXPANDED_PATHS_STORAGE_PREFIX = "markdown-note-expanded-paths:";

function initialize() {
  configureLibraries();
  bindEvents();
  setEditorEnabled(false);
  renderEmpty();
  refreshIcons();
}

function configureLibraries() {
  if (window.marked) {
    marked.setOptions({
      breaks: false,
      gfm: true,
      headerIds: false,
      mangle: false
    });
  }
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default"
    });
  }
}

function bindEvents() {
  elements.loadButton.addEventListener("click", loadRootFolder);
  elements.toggleViewerButton.addEventListener("click", () => setViewerOnly(!viewerOnly));
  elements.newCategoryButton.addEventListener("click", createCategory);
  elements.newPageButton.addEventListener("click", createPage);
  elements.renameButton.addEventListener("click", renameSelected);
  elements.deleteButton.addEventListener("click", deleteSelected);

  elements.editor.addEventListener("input", () => {
    invalidateEditorLineMetrics();
    renderPage(elements.editor.value);
    syncPreviewToEditorLine(getEditorCursorLine(), 0.35);
    queueSave();
  });
  elements.editor.addEventListener("paste", handlePaste);
  elements.editor.addEventListener("drop", handleDrop);
  elements.editor.addEventListener("dragover", (event) => event.preventDefault());
  elements.editor.addEventListener("scroll", () => syncPreviewFromEditor());
  elements.preview.addEventListener("scroll", () => syncEditorFromPreview());

  document.querySelectorAll(".resizer").forEach((resizer) => {
    resizer.addEventListener("pointerdown", startResize);
  });

  window.addEventListener("beforeunload", (event) => {
    if (saveState === "dirty" || saveState === "saving") {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  elements.dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    closeDialog(elements.dialogInput.value);
  });
  elements.dialogCancelButton.addEventListener("click", () => closeDialog(null));
  elements.dialogCloseButton.addEventListener("click", () => closeDialog(null));
  elements.dialogBackdrop.addEventListener("click", (event) => {
    if (event.target === elements.dialogBackdrop) closeDialog(null);
  });
}

async function loadRootFolder() {
  if (!window.showDirectoryPicker) {
    alert("フォルダ読み込みには Chrome の File System Access API が必要です。localhost で開いてください。");
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const ok = await requestReadWritePermission(handle);
    if (!ok) {
      setSaveStatus("error", "権限なし");
      elements.folderStatus.textContent = "書き込み権限がありません";
      return;
    }

    rootHandle = handle;
    selectedNode = null;
    selectedPageNode = null;
    clearObjectUrls();
    loadExpandedPaths();
    await scanAndRender();
    elements.folderStatus.textContent = handle.name;
    setSaveStatus("saved", "読み込み済み");
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      setSaveStatus("error", "読込失敗");
      alert("フォルダを読み込めませんでした。");
    }
  }
}

async function requestReadWritePermission(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function scanAndRender(selectPath = null) {
  if (!rootHandle) return;
  treeRoot = await scanDirectory(rootHandle, "", null);
  sortTree(treeRoot);
  if (selectPath) {
    const nextNode = findNodeByPath(treeRoot, selectPath);
    if (nextNode) selectedNode = nextNode;
  }
  renderTree();
  if (!selectedPageNode && treeRoot) {
    const firstPage = findFirstPage(treeRoot);
    if (firstPage) await selectNode(firstPage);
  }
  refreshIcons();
}

async function scanDirectory(handle, path, parent) {
  const entries = [];
  let hasIndex = false;
  let hasSrc = false;
  let childDirectoryCount = 0;

  for await (const [name, childHandle] of handle.entries()) {
    if (childHandle.kind === "file" && name === "index.md") hasIndex = true;
    if (childHandle.kind === "directory") {
      if (name === "src") {
        hasSrc = true;
      } else {
        childDirectoryCount += 1;
        entries.push({ name, handle: childHandle });
      }
    }
  }

  const warnings = [];
  let type = "category";
  if (hasIndex && hasSrc && childDirectoryCount === 0) {
    type = "page";
  } else if (!hasIndex && !hasSrc) {
    type = "category";
  } else {
    type = "invalid";
    if (hasIndex && !hasSrc) warnings.push("index.md は存在するが src/ が存在しません");
    if (!hasIndex && hasSrc) warnings.push("src/ は存在するが index.md が存在しません");
    if (hasIndex && hasSrc && childDirectoryCount > 0) warnings.push("ページフォルダ配下に子フォルダがあります");
    if ((hasIndex || hasSrc) && childDirectoryCount > 0) warnings.push("カテゴリフォルダに index.md または src/ が存在します");
  }

  const node = {
    name: handle.name,
    path,
    handle,
    parent,
    type,
    warnings,
    children: []
  };

  for (const entry of entries) {
    const childPath = path ? `${path}/${entry.name}` : entry.name;
    node.children.push(await scanDirectory(entry.handle, childPath, node));
  }

  return node;
}

function sortTree(node) {
  node.children.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  node.children.forEach(sortTree);
}

function renderTree() {
  if (!treeRoot) {
    elements.treeList.innerHTML = '<div class="empty-state">右上の「読み込み」からルートフォルダを選択してください。</div>';
    return;
  }
  elements.treeList.innerHTML = renderTreeNode(treeRoot, true);
  elements.treeList.querySelectorAll("[data-action='toggle']").forEach((button) => {
    button.addEventListener("click", () => {
      const path = button.dataset.path;
      if (expandedPaths.has(path)) expandedPaths.delete(path);
      else expandedPaths.add(path);
      saveExpandedPaths();
      renderTree();
      refreshIcons();
    });
  });
  elements.treeList.querySelectorAll("[data-action='select']").forEach((button) => {
    button.addEventListener("click", async () => {
      const node = findNodeByPath(treeRoot, button.dataset.path);
      if (node) await selectNode(node);
    });
  });
  bindTreeDragAndDrop();
}

function renderTreeNode(node, isRoot = false) {
  const hasChildren = node.children.length > 0;
  const expanded = expandedPaths.has(node.path);
  const active = selectedNode?.path === node.path;
  const icon = node.type === "page" ? "file-text" : node.type === "invalid" ? "triangle-alert" : "folder";
  const displayName = getTreeDisplayName(node);
  const rowClass = ["tree-row", active ? "active" : "", node.type === "invalid" ? "invalid" : ""].filter(Boolean).join(" ");
  const title = node.warnings.length ? ` title="${escapeAttr(node.warnings.join("\n"))}"` : "";
  const toggleIcon = hasChildren ? (expanded ? "chevron-down" : "chevron-right") : "";
  const children = hasChildren
    ? `<div class="tree-children${expanded ? "" : " collapsed"}">${node.children.map((child) => renderTreeNode(child)).join("")}</div>`
    : "";

  return `
    <div class="tree-node"${title}>
      <div class="${rowClass}" data-tree-row data-path="${escapeAttr(node.path)}" ${isRoot ? "" : 'draggable="true"'}>
        <button class="tree-toggle" type="button" data-action="toggle" data-path="${escapeAttr(node.path)}" ${hasChildren ? "" : "tabindex='-1' aria-hidden='true'"}>
          ${toggleIcon ? `<i data-lucide="${toggleIcon}"></i>` : ""}
        </button>
        <button class="tree-label" type="button" data-action="select" data-path="${escapeAttr(node.path)}">
          <i data-lucide="${icon}"></i>
          <span class="tree-name">${escapeHtml(displayName)}</span>
        </button>
      </div>
      ${children}
    </div>
  `;
}

function bindTreeDragAndDrop() {
  elements.treeList.querySelectorAll("[data-tree-row]").forEach((row) => {
    row.addEventListener("dragstart", handleTreeDragStart);
    row.addEventListener("dragover", handleTreeDragOver);
    row.addEventListener("dragleave", handleTreeDragLeave);
    row.addEventListener("drop", handleTreeDrop);
    row.addEventListener("dragend", clearTreeDragState);
  });
}

function handleTreeDragStart(event) {
  const path = event.currentTarget.dataset.path;
  const node = findNodeByPath(treeRoot, path);
  if (!node || node === treeRoot) {
    event.preventDefault();
    return;
  }

  draggingTreePath = path;
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", path);
}

function handleTreeDragOver(event) {
  if (!draggingTreePath) return;
  const targetPath = event.currentTarget.dataset.path;
  const source = findNodeByPath(treeRoot, draggingTreePath);
  const target = findNodeByPath(treeRoot, targetPath);

  if (canMoveNodeTo(source, target)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.classList.add("drop-target");
  } else {
    event.currentTarget.classList.add("drop-denied");
  }
}

function handleTreeDragLeave(event) {
  event.currentTarget.classList.remove("drop-target", "drop-denied");
}

async function handleTreeDrop(event) {
  event.preventDefault();
  const targetPath = event.currentTarget.dataset.path;
  clearTreeDragHighlights();

  try {
    await moveTreeNode(draggingTreePath, targetPath);
  } catch (error) {
    reportOperationError("移動できませんでした。", error);
  } finally {
    draggingTreePath = null;
  }
}

function clearTreeDragState() {
  draggingTreePath = null;
  clearTreeDragHighlights();
}

function clearTreeDragHighlights() {
  elements.treeList.querySelectorAll(".dragging, .drop-target, .drop-denied").forEach((row) => {
    row.classList.remove("dragging", "drop-target", "drop-denied");
  });
}

function canMoveNodeTo(source, target) {
  if (!source || !target) return false;
  if (source === treeRoot) return false;
  if (target.type !== "category") return false;
  if (source === target) return false;
  if (source.parent === target) return false;
  if (isDescendantNode(target, source)) return false;
  return true;
}

function isDescendantNode(node, possibleAncestor) {
  let current = node.parent;
  while (current) {
    if (current === possibleAncestor) return true;
    current = current.parent;
  }
  return false;
}

function getTreeDisplayName(node) {
  if (node.type === "page") return node.name;
  return `${node.name}${node.name.endsWith("/") ? "" : "/"}`;
}

async function selectNode(node) {
  await saveNow();
  selectedNode = node;
  renderTree();
  refreshIcons();

  if (node.type !== "page") {
    selectedPageNode = null;
    setEditorEnabled(false);
    const message = node.type === "invalid"
      ? `# 不正な構造\n\n${node.warnings.map((item) => `- ${item}`).join("\n")}`
      : "# カテゴリフォルダ\n\nページフォルダを選択してください。";
    elements.editor.value = "";
    renderPage(message);
    elements.folderStatus.textContent = `${rootHandle.name} / ${node.path || "."}`;
    return;
  }

  selectedPageNode = node;
  clearObjectUrls();
  setEditorEnabled(true);
  const indexHandle = await node.handle.getFileHandle("index.md");
  const file = await indexHandle.getFile();
  elements.editor.value = await file.text();
  invalidateEditorLineMetrics();
  await deleteUnusedSrcFiles(node, elements.editor.value);
  renderPage(elements.editor.value);
  elements.folderStatus.textContent = `${rootHandle.name} / ${node.path}/index.md`;
  setSaveStatus("saved", "保存済み");
}

function setEditorEnabled(enabled) {
  elements.editor.disabled = !enabled;
  elements.newCategoryButton.disabled = !rootHandle;
  elements.newPageButton.disabled = !rootHandle;
  elements.renameButton.disabled = !selectedNode || selectedNode === treeRoot;
  elements.deleteButton.disabled = !selectedNode || selectedNode === treeRoot;
}

function renderEmpty() {
  elements.treeList.innerHTML = '<div class="empty-state">右上の「読み込み」からルートフォルダを選択してください。</div>';
  renderPage("# Markdown Note\n\nローカルフォルダを読み込むと、階層ツリーから Markdown ページを編集できます。");
}

async function createCategory() {
  try {
    const parent = getWritableCategoryTarget();
    if (!parent) return;
    const name = await showPromptDialog("カテゴリを作成", "新しいカテゴリフォルダ名を入力してください。", "新規カテゴリ");
    if (!name) return;
    const cleanName = sanitizeFolderName(name);
    await createDirectoryIfAvailable(parent.handle, cleanName);
    const path = parent.path ? `${parent.path}/${cleanName}` : cleanName;
    expandAncestorPaths(path);
    expandedPaths.add(path);
    saveExpandedPaths();
    await scanAndRender(path);
    const node = findNodeByPath(treeRoot, path);
    if (node) await selectNode(node);
  } catch (error) {
    reportOperationError("カテゴリを作成できませんでした。", error);
  }
}

async function createPage() {
  try {
    const parent = getWritableCategoryTarget();
    if (!parent) return;
    const rawName = await showPromptDialog("ページを作成", "新しいページフォルダ名を入力してください。", "新規ページ");
    if (!rawName) return;
    const name = sanitizeFolderName(rawName);
    const pageHandle = await createDirectoryIfAvailable(parent.handle, name);
    await pageHandle.getDirectoryHandle("src", { create: true });
    const indexHandle = await pageHandle.getFileHandle("index.md", { create: true });
    await writeFile(indexHandle, `# ${name}\n`);
    const path = parent.path ? `${parent.path}/${name}` : name;
    expandAncestorPaths(path);
    saveExpandedPaths();
    await scanAndRender(path);
    const node = findNodeByPath(treeRoot, path);
    if (node) await selectNode(node);
  } catch (error) {
    reportOperationError("ページを作成できませんでした。", error);
  }
}

function getWritableCategoryTarget() {
  if (!rootHandle || !treeRoot) {
    alert("先にルートフォルダを読み込んでください。");
    return null;
  }
  if (!selectedNode) return treeRoot;
  if (selectedNode.type === "category") return selectedNode;
  return selectedNode.parent || treeRoot;
}

function expandAncestorPaths(path) {
  expandedPaths.add("");
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    expandedPaths.add(current);
  }
}

function getExpandedPathsStorageKey() {
  return `${EXPANDED_PATHS_STORAGE_PREFIX}${rootHandle?.name || "default"}`;
}

function loadExpandedPaths() {
  expandedPaths.clear();
  try {
    const raw = localStorage.getItem(getExpandedPathsStorageKey());
    if (!raw) {
      expandedPaths.add("");
      return;
    }
    const paths = JSON.parse(raw);
    if (Array.isArray(paths)) {
      paths.forEach((path) => {
        if (typeof path === "string") expandedPaths.add(path);
      });
    }
  } catch {
    expandedPaths.add("");
  }
}

function saveExpandedPaths() {
  try {
    localStorage.setItem(getExpandedPathsStorageKey(), JSON.stringify([...expandedPaths]));
  } catch (error) {
    console.warn("展開状態を保存できませんでした。", error);
  }
}

function removeExpandedPathBranch(path) {
  for (const expandedPath of [...expandedPaths]) {
    if (expandedPath === path || expandedPath.startsWith(`${path}/`)) {
      expandedPaths.delete(expandedPath);
    }
  }
}

async function moveTreeNode(sourcePath, targetPath) {
  if (!sourcePath && sourcePath !== "") return;
  const source = findNodeByPath(treeRoot, sourcePath);
  const target = findNodeByPath(treeRoot, targetPath);
  if (!canMoveNodeTo(source, target)) {
    throw new Error("移動先にはカテゴリフォルダを選択してください。");
  }

  await saveNow();
  await ensureMissing(target.handle, source.name);
  const targetHandle = await target.handle.getDirectoryHandle(source.name, { create: true });
  await copyDirectory(source.handle, targetHandle);
  await source.parent.handle.removeEntry(source.name, { recursive: true });

  const newPath = target.path ? `${target.path}/${source.name}` : source.name;
  expandedPaths.delete(source.path);
  expandedPaths.add(target.path);
  expandAncestorPaths(newPath);
  if (source.type === "category") expandedPaths.add(newPath);
  saveExpandedPaths();

  selectedNode = null;
  selectedPageNode = null;
  setEditorEnabled(false);
  await scanAndRender(newPath);
  const movedNode = findNodeByPath(treeRoot, newPath);
  if (movedNode) await selectNode(movedNode);
}

async function renameSelected() {
  try {
    if (!selectedNode || selectedNode === treeRoot) return;
    await saveNow();
    const nextName = await showPromptDialog("名前を変更", "新しいフォルダ名を入力してください。", selectedNode.name);
    if (!nextName || nextName === selectedNode.name) return;
    const cleanName = sanitizeFolderName(nextName);
    const parent = selectedNode.parent;
    const oldPath = selectedNode.path;
    const wasExpanded = expandedPaths.has(oldPath);
    await ensureMissing(parent.handle, cleanName);
    const targetHandle = await parent.handle.getDirectoryHandle(cleanName, { create: true });
    await copyDirectory(selectedNode.handle, targetHandle);
    await parent.handle.removeEntry(selectedNode.name, { recursive: true });
    const path = parent.path ? `${parent.path}/${cleanName}` : cleanName;
    if (wasExpanded) {
      expandedPaths.delete(oldPath);
      expandedPaths.add(path);
    }
    expandAncestorPaths(path);
    saveExpandedPaths();
    await scanAndRender(path);
    const node = findNodeByPath(treeRoot, path);
    if (node) await selectNode(node);
  } catch (error) {
    reportOperationError("名前を変更できませんでした。", error);
  }
}

async function deleteSelected() {
  try {
    if (!selectedNode || selectedNode === treeRoot) return;
    const message = `削除対象: ${selectedNode.name}\n\nこの操作は取り消せません。削除するには同じ名前を入力してください。`;
    const confirmation = await showPromptDialog("削除確認", message, "", selectedNode.name);
    if (confirmation !== selectedNode.name) return;
    await saveNow();
    const parent = selectedNode.parent;
    removeExpandedPathBranch(selectedNode.path);
    await parent.handle.removeEntry(selectedNode.name, { recursive: true });
    selectedNode = parent;
    selectedPageNode = null;
    setEditorEnabled(false);
    saveExpandedPaths();
    await scanAndRender(parent.path);
    await selectNode(parent);
  } catch (error) {
    reportOperationError("削除できませんでした。", error);
  }
}

async function createDirectoryIfAvailable(parentHandle, name) {
  await ensureMissing(parentHandle, name);
  return parentHandle.getDirectoryHandle(name, { create: true });
}

async function ensureMissing(parentHandle, name) {
  try {
    await parentHandle.getDirectoryHandle(name);
    throw new Error(`同名フォルダが既に存在します: ${name}`);
  } catch (error) {
    if (error.name === "NotFoundError") return;
    throw error;
  }
}

async function copyDirectory(fromHandle, toHandle) {
  for await (const [name, childHandle] of fromHandle.entries()) {
    if (childHandle.kind === "file") {
      const file = await childHandle.getFile();
      const target = await toHandle.getFileHandle(name, { create: true });
      await writeFile(target, file);
    } else {
      const target = await toHandle.getDirectoryHandle(name, { create: true });
      await copyDirectory(childHandle, target);
    }
  }
}

function sanitizeFolderName(name) {
  return name.trim().replace(/[\\/:*?"<>|]/g, "-") || "untitled";
}

function queueSave() {
  if (!selectedPageNode) return;
  setSaveStatus("dirty", "未保存");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!selectedPageNode || elements.editor.disabled || saveState === "saving") return;
  setSaveStatus("saving", "保存中");
  try {
    const indexHandle = await selectedPageNode.handle.getFileHandle("index.md");
    await writeFile(indexHandle, elements.editor.value);
    setSaveStatus("saved", "保存済み");
  } catch (error) {
    console.error(error);
    setSaveStatus("error", "保存失敗");
  }
}

async function writeFile(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

function setSaveStatus(state, label) {
  saveState = state;
  elements.saveStatus.className = `save-status ${state}`;
  elements.saveStatus.textContent = label;
}

function renderPage(markdown) {
  const sequence = ++renderSequence;
  headings = extractHeadings(markdown);
  activeHeadingId = headings[0]?.id || "";
  elements.preview.innerHTML = renderMarkdown(markdown);
  collectPreviewSourceElements();
  renderToc();
  resolveLocalLinks(sequence);
  renderAdvancedBlocks();
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headingByLine = new Map(headings.map((heading) => [heading.lineIndex, heading]));
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = headingByLine.get(index);
      const id = heading?.id || slugify(stripMarkdown(headingMatch[2])) || `heading-${index + 1}`;
      html.push(`<h${level} id="${escapeAttr(id)}" data-heading-id="${escapeAttr(id)}" data-source-line="${index}">${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const start = index;
      const language = line.replace(/^\s*```/, "").trim().toLowerCase();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const codeText = code.join("\n");
      if (language === "mermaid") {
        html.push(`<div class="diagram-block mermaid" data-source-line="${start}">${escapeHtml(codeText)}</div>`);
      } else {
        html.push(`<pre data-source-line="${start}"><code class="language-${escapeAttr(language)}">${escapeHtml(codeText)}</code></pre>`);
      }
      continue;
    }

    if (/^\s*\$\$\s*$/.test(line)) {
      const start = index;
      const latex = [];
      index += 1;
      while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index])) {
        latex.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(renderMathBlock(latex.join("\n"), start));
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const start = index;
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      html.push(renderSourceMappedTable(tableLines, start));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const start = index;
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push({ line: index, text: lines[index].replace(/^\s*>\s?/, "") });
        index += 1;
      }
      html.push(`<blockquote data-source-line="${start}">${quoteLines.map((item) => `<p data-source-line="${item.line}">${renderInlineMarkdown(item.text)}</p>`).join("")}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const start = index;
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push({ line: index, text: lines[index].replace(/^\s*[-*+]\s+/, "") });
        index += 1;
      }
      html.push(renderSourceMappedList("ul", items, start));
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const start = index;
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push({ line: index, text: lines[index].replace(/^\s*\d+\.\s+/, "") });
        index += 1;
      }
      html.push(renderSourceMappedList("ol", items, start));
      continue;
    }

    if (isMarkdownHorizontalRule(line)) {
      html.push(`<hr data-source-line="${index}">`);
      index += 1;
      continue;
    }

    const start = index;
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+.+$/.test(lines[index]) &&
      !/^\s*```/.test(lines[index]) &&
      !/^\s*\$\$\s*$/.test(lines[index]) &&
      !isMarkdownTableStart(lines, index) &&
      !/^\s*>\s?/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !isMarkdownHorizontalRule(lines[index])
    ) {
      paragraph.push({ line: index, text: lines[index] });
      index += 1;
    }
    html.push(`<p data-source-line="${start}">${paragraph.map((item, itemIndex) => {
      const separator = itemIndex < paragraph.length - 1 ? "\n" : "";
      return `<span data-source-line="${item.line}">${renderInlineMarkdown(item.text)}</span>${separator}`;
    }).join("")}</p>`);
  }

  return html.join("\n");
}

function collectPreviewSourceElements() {
  previewSourceElements = Array.from(elements.preview.querySelectorAll("[data-source-line]"))
    .sort((a, b) => {
      const lineDiff = Number(a.dataset.sourceLine) - Number(b.dataset.sourceLine);
      if (lineDiff !== 0) return lineDiff;
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
}

function renderInlineMarkdown(text) {
  const mathTokens = [];
  const tokenized = text.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (match, prefix, latex) => {
    const token = `@@INLINE_MATH_${mathTokens.length}@@`;
    mathTokens.push(latex.trim());
    return `${prefix}${token}`;
  });
  let html = marked.parseInline(tokenized);
  html = html.replace(/@@INLINE_MATH_(\d+)@@/g, (_, index) => renderMathInline(mathTokens[Number(index)] || ""));
  return html;
}

function renderMathInline(latex) {
  try {
    return katex.renderToString(latex, { throwOnError: false, displayMode: false });
  } catch {
    return escapeHtml(latex);
  }
}

function renderMathBlock(latex, line) {
  try {
    return `<div class="math-block" data-source-line="${line}">${katex.renderToString(latex, { throwOnError: false, displayMode: true })}</div>`;
  } catch {
    return `<div class="math-block" data-source-line="${line}">${escapeHtml(latex)}</div>`;
  }
}

function renderSourceMappedList(tag, items, startLine) {
  const listItems = items.map((item) => {
    const task = item.text.match(/^\[(x|X| )]\s+(.*)$/);
    if (!task) return `<li data-source-line="${item.line}">${renderInlineMarkdown(item.text)}</li>`;
    const checked = task[1].toLowerCase() === "x" ? " checked" : "";
    return `<li class="task-list-item" data-source-line="${item.line}"><input type="checkbox" disabled${checked}> ${renderInlineMarkdown(task[2])}</li>`;
  }).join("");
  return `<${tag} data-source-line="${startLine}">${listItems}</${tag}>`;
}

function renderSourceMappedTable(tableLines, startLine) {
  const headers = splitMarkdownTableRow(tableLines[0]);
  const alignments = splitMarkdownTableRow(tableLines[1]).map(getMarkdownTableAlignment);
  const headerCells = headers.map((header, index) => `<th${tableAlignAttribute(alignments[index])}>${renderInlineMarkdown(header)}</th>`).join("");
  const bodyRows = tableLines.slice(2).map((line, rowIndex) => {
    const lineNumber = startLine + rowIndex + 2;
    const cells = splitMarkdownTableRow(line);
    const rowCells = headers.map((_, cellIndex) => `<td${tableAlignAttribute(alignments[cellIndex])}>${renderInlineMarkdown(cells[cellIndex] || "")}</td>`).join("");
    return `<tr data-source-line="${lineNumber}">${rowCells}</tr>`;
  }).join("");
  return `<table data-source-line="${startLine}"><thead><tr data-source-line="${startLine}">${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function splitMarkdownTableRow(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function getMarkdownTableAlignment(separator) {
  if (/^:-+:$/.test(separator)) return "center";
  if (/^-+:$/.test(separator)) return "right";
  if (/^:-+$/.test(separator)) return "left";
  return "";
}

function tableAlignAttribute(alignment) {
  return alignment ? ` style="text-align: ${alignment}"` : "";
}

async function renderAdvancedBlocks() {
  if (!window.mermaid) return;
  try {
    await mermaid.run({ nodes: elements.preview.querySelectorAll(".mermaid") });
  } catch (error) {
    console.warn(error);
  }
}

function renderToc() {
  if (headings.length === 0) {
    elements.tocList.innerHTML = '<div class="toc-empty">見出しがありません</div>';
    return;
  }

  elements.tocList.innerHTML = headings.map((heading) => (
    `<button class="toc-item toc-level-${heading.level}${heading.id === activeHeadingId ? " active" : ""}" type="button" data-heading-id="${escapeAttr(heading.id)}">${escapeHtml(heading.text)}</button>`
  )).join("");

  elements.tocList.querySelectorAll(".toc-item").forEach((button) => {
    button.addEventListener("click", () => jumpToHeading(button.dataset.headingId));
  });
}

function jumpToHeading(id) {
  activeHeadingId = id;
  renderToc();
  const target = elements.preview.querySelector(`[data-heading-id="${cssEscape(id)}"]`);
  if (target) {
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    clearTimeout(headingHighlightTimer);
    elements.preview.querySelectorAll(".heading-highlight").forEach((element) => {
      element.classList.remove("heading-highlight");
    });
    target.classList.remove("heading-highlight");
    requestAnimationFrame(() => {
      target.classList.add("heading-highlight");
      headingHighlightTimer = setTimeout(() => {
        target.classList.remove("heading-highlight");
        headingHighlightTimer = null;
      }, 1800);
    });
  }
  const heading = headings.find((item) => item.id === id);
  if (heading) selectEditorLine(heading.lineIndex);
}

function selectEditorLine(lineIndex) {
  if (elements.editor.disabled) return;
  const lines = elements.editor.value.split(/\r?\n/);
  const start = lines.slice(0, lineIndex).join("\n").length + (lineIndex > 0 ? 1 : 0);
  const end = start + lines[lineIndex].length;
  elements.editor.focus({ preventScroll: true });
  elements.editor.setSelectionRange(start, end);
  elements.editor.scrollTop = Math.max(0, getEditorLineTop(lineIndex) - elements.editor.clientHeight * 0.18);
}

function isMarkdownTableStart(lines, index) {
  return index + 1 < lines.length && /\|/.test(lines[index]) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]);
}

function isMarkdownHorizontalRule(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

async function resolveLocalLinks(sequence) {
  if (!selectedPageNode) return;
  const images = Array.from(elements.preview.querySelectorAll("img[src]"));
  const anchors = Array.from(elements.preview.querySelectorAll("a[href]"));
  for (const image of images) {
    if (sequence !== renderSequence) return;
    const src = image.getAttribute("src");
    if (isExternalUrl(src)) continue;
    const url = await getObjectUrlForPagePath(src);
    if (url) image.src = url;
  }
  for (const anchor of anchors) {
    if (sequence !== renderSequence) return;
    const href = anchor.getAttribute("href");
    if (isExternalUrl(href)) continue;
    const url = await getObjectUrlForPagePath(href);
    if (url) {
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
    }
  }
}

async function deleteUnusedSrcFiles(pageNode, markdown) {
  let srcHandle = null;
  try {
    srcHandle = await pageNode.handle.getDirectoryHandle("src");
  } catch {
    return;
  }

  const usedFiles = extractUsedSrcFileNames(markdown);

  for await (const [name, handle] of srcHandle.entries()) {
    if (handle.kind !== "file") continue;
    if (usedFiles.has(name)) continue;
    try {
      await srcHandle.removeEntry(name);
    } catch (error) {
      console.warn(`未使用添付ファイルを削除できませんでした: ${name}`, error);
    }
  }
}

function extractUsedSrcFileNames(markdown) {
  const used = new Set();

  for (const reference of extractMarkdownLinkDestinations(markdown)) {
    const fileName = getSrcFileNameFromReference(reference);
    if (fileName) used.add(fileName);
  }

  const htmlAttributePattern = /<(?:img|a)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  let match = htmlAttributePattern.exec(markdown);
  while (match) {
    const fileName = getSrcFileNameFromReference(match[1]);
    if (fileName) used.add(fileName);
    match = htmlAttributePattern.exec(markdown);
  }

  return used;
}

function extractMarkdownLinkDestinations(markdown) {
  const destinations = [];
  let searchIndex = 0;

  while (searchIndex < markdown.length) {
    const openIndex = markdown.indexOf("](", searchIndex);
    if (openIndex === -1) break;

    let index = openIndex + 2;
    let destination = "";

    if (markdown[index] === "<") {
      index += 1;
      while (index < markdown.length && markdown[index] !== ">") {
        destination += markdown[index];
        index += 1;
      }
    } else {
      let depth = 0;
      let escaped = false;

      while (index < markdown.length) {
        const char = markdown[index];

        if (escaped) {
          destination += char;
          escaped = false;
          index += 1;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          index += 1;
          continue;
        }

        if (char === "(") {
          depth += 1;
          destination += char;
          index += 1;
          continue;
        }

        if (char === ")") {
          if (depth === 0) break;
          depth -= 1;
          destination += char;
          index += 1;
          continue;
        }

        if (/\s/.test(char) && depth === 0) break;

        destination += char;
        index += 1;
      }
    }

    if (destination.trim()) destinations.push(destination.trim());
    searchIndex = openIndex + 2;
  }

  return destinations;
}

function getSrcFileNameFromReference(reference) {
  const clean = decodeMarkdownUrl(reference)
    .split("#")[0]
    .split("?")[0]
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");

  if (!clean.startsWith("src/")) return "";
  const rest = clean.slice("src/".length);
  if (!rest || rest.includes("/")) return "";
  return rest;
}

function decodeMarkdownUrl(value) {
  try {
    return decodeURIComponent(value.trim());
  } catch {
    return value.trim();
  }
}

async function getObjectUrlForPagePath(path) {
  const cleanPath = decodeURIComponent(path).replace(/^\.\/+/, "");
  const cached = objectUrls.get(cleanPath);
  if (cached) return cached;
  try {
    const fileHandle = await getFileHandleByRelativePath(selectedPageNode.handle, cleanPath);
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    objectUrls.set(cleanPath, url);
    return url;
  } catch {
    return null;
  }
}

async function getFileHandleByRelativePath(baseHandle, path) {
  const segments = path.split("/").filter(Boolean);
  let current = baseHandle;
  for (const segment of segments.slice(0, -1)) {
    if (segment === ".") continue;
    if (segment === "..") throw new Error("Parent paths are not resolved in preview attachments.");
    current = await current.getDirectoryHandle(segment);
  }
  return current.getFileHandle(segments[segments.length - 1]);
}

function clearObjectUrls() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

async function handlePaste(event) {
  const files = getClipboardImageFiles(event);
  if (!files.length) return;
  event.preventDefault();
  await insertFiles(files, { imageOnly: true, useUuidName: true });
}

async function handleDrop(event) {
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  await insertFiles(files, { imageOnly: false, useUuidName: false });
}

async function insertFiles(files, options = {}) {
  if (!selectedPageNode) {
    alert("先にページフォルダを選択してください。");
    return;
  }
  const { imageOnly = false, useUuidName = false } = options;
  const srcHandle = await selectedPageNode.handle.getDirectoryHandle("src", { create: true });
  const inserted = [];
  for (const file of files) {
    if (imageOnly && !isImageFile(file)) continue;
    const fileName = useUuidName ? uuidFileName(file) : (file.name || defaultFileName(file));
    const safeName = await uniqueFileName(srcHandle, fileName);
    const handle = await srcHandle.getFileHandle(safeName, { create: true });
    await writeFile(handle, file);
    const isImage = isImageFile(file);
    inserted.push(isImage ? `![${safeName}](./src/${safeName})` : `[${safeName}](./src/${safeName})`);
  }
  if (inserted.length) {
    insertAtCursor(inserted.join("\n\n"));
    renderPage(elements.editor.value);
    queueSave();
  }
}

function getClipboardImageFiles(event) {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return [];
  const fromFiles = Array.from(clipboardData.files || []).filter(isImageFile);
  if (fromFiles.length) return fromFiles;
  return Array.from(clipboardData.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(isImageFile);
}

function insertAtCursor(text) {
  const editor = elements.editor;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n" : "";
  const insertion = `${prefix}${text}${suffix}`;
  editor.value = `${before}${insertion}${after}`;
  const cursor = before.length + insertion.length;
  editor.setSelectionRange(cursor, cursor);
}

async function uniqueFileName(directoryHandle, name) {
  const safe = (name || "file").replace(/[\\/:*?"<>|]/g, "-");
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  let candidate = safe;
  let count = 1;
  while (await fileExists(directoryHandle, candidate)) {
    candidate = `${base}(${count})${ext}`;
    count += 1;
  }
  return candidate;
}

async function fileExists(directoryHandle, name) {
  try {
    await directoryHandle.getFileHandle(name);
    return true;
  } catch (error) {
    return error.name !== "NotFoundError";
  }
}

function defaultFileName(file) {
  const ext = file.type?.startsWith("image/") ? extensionFromMime(file.type) : "";
  return `file-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}${ext}`;
}

function uuidFileName(file) {
  const extension = extensionFromMime(file.type) || extensionFromFileName(file.name) || ".png";
  return `${crypto.randomUUID()}${extension}`;
}

function extensionFromFileName(name = "") {
  const match = name.match(/(\.[A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function reportOperationError(message, error) {
  console.error(error);
  setSaveStatus("error", "操作失敗");
  alert(`${message}\n${error.message || "権限や同名フォルダを確認してください。"}`);
}

function extensionFromMime(mimeType) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg"
  };
  return map[mimeType] || ".png";
}

function isImageFile(file) {
  if (!file) return false;
  return file.type?.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name || "");
}

function setViewerOnly(enabled) {
  viewerOnly = enabled;
  elements.workspace.classList.toggle("viewer-only", enabled);
  setToggleViewerButtonIcon(enabled ? "pencil" : "panel-right-open");
  elements.toggleViewerButton.title = enabled ? "Editorを表示" : "閲覧モードに切り替え";
  elements.toggleViewerButton.setAttribute("aria-label", elements.toggleViewerButton.title);
  refreshIcons();
}

function setToggleViewerButtonIcon(iconName) {
  elements.toggleViewerButton.innerHTML = `<i data-lucide="${iconName}"></i>`;
}

function syncPreviewFromEditor() {
  if (suppressEditorScroll || !selectedPageNode) return;
  syncPreviewToEditorLinePosition(getEditorTopLinePosition(), 0);
}

function syncEditorFromPreview() {
  if (suppressPreviewScroll || !selectedPageNode || elements.editor.disabled) return;
  const position = getPreviewTopSourcePosition();
  if (!position) return;
  syncEditorToLinePosition(position, 0);
}

function syncPreviewToEditorLine(lineIndex, viewportRatio) {
  syncPreviewToEditorLinePosition({ line: lineIndex, progress: 0 }, viewportRatio);
}

function syncPreviewToEditorLinePosition(position, viewportRatio) {
  const lineIndex = position?.line ?? 0;
  const target = findPreviewElementForLine(lineIndex);
  if (!target) return;

  suppressPreviewScroll = true;
  const progress = clamp(position?.progress ?? 0, 0, 1);
  const targetHeight = target.getBoundingClientRect().height || target.offsetHeight || 1;
  const nextTop = getElementTopInScrollContainer(target, elements.preview) + targetHeight * progress - elements.preview.clientHeight * viewportRatio;
  elements.preview.scrollTop = Math.max(0, nextTop);
  setTimeout(() => {
    suppressPreviewScroll = false;
  }, 80);
}

function syncEditorToLine(lineIndex, viewportRatio) {
  syncEditorToLinePosition({ line: lineIndex, progress: 0 }, viewportRatio);
}

function syncEditorToLinePosition(position, viewportRatio) {
  const metrics = getEditorLineMetrics();
  const safeIndex = Math.min(Math.max(0, position?.line ?? 0), metrics.tops.length - 1);
  const lineTop = metrics.tops[safeIndex] || 0;
  const lineBottom = metrics.bottoms[safeIndex] || lineTop + getEditorLineHeight();
  const progress = clamp(position?.progress ?? 0, 0, 1);

  suppressEditorScroll = true;
  elements.editor.scrollTop = Math.max(0, lineTop + (lineBottom - lineTop) * progress - elements.editor.clientHeight * viewportRatio);
  setTimeout(() => {
    suppressEditorScroll = false;
  }, 80);
}

function findPreviewElementForLine(lineIndex) {
  if (!previewSourceElements.length) return null;
  let best = previewSourceElements[0];

  for (const element of previewSourceElements) {
    const sourceLine = Number(element.dataset.sourceLine);
    if (!Number.isFinite(sourceLine)) continue;
    if (sourceLine > lineIndex) break;
    best = element;
  }

  return best;
}

function getPreviewTopSourceLine() {
  return getPreviewTopSourcePosition()?.line ?? null;
}

function getPreviewTopSourcePosition() {
  if (!previewSourceElements.length) return null;
  const top = elements.preview.scrollTop + 1;
  let best = null;
  let fallback = null;
  let fallbackTop = -Infinity;

  for (const element of previewSourceElements) {
    const line = Number(element.dataset.sourceLine);
    if (!Number.isFinite(line)) continue;
    const elementTop = getElementTopInScrollContainer(element, elements.preview);
    const elementHeight = element.getBoundingClientRect().height || element.offsetHeight || 1;
    const elementBottom = elementTop + elementHeight;

    if (elementTop <= top && elementBottom >= top) {
      const candidate = {
        line,
        progress: clamp((top - elementTop) / elementHeight, 0, 1),
        height: elementHeight
      };
      if (!best || candidate.height < best.height || (candidate.height === best.height && candidate.line > best.line)) {
        best = candidate;
      }
    }

    if (elementTop <= top && elementTop >= fallbackTop) {
      fallbackTop = elementTop;
      fallback = { line, progress: 1 };
    }
  }

  return best || fallback || { line: Number(previewSourceElements[0].dataset.sourceLine) || 0, progress: 0 };
}

function getElementTopInScrollContainer(element, container) {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elementRect.top - containerRect.top + container.scrollTop;
}

function getEditorCursorLine() {
  return elements.editor.value.slice(0, elements.editor.selectionStart).split(/\r?\n/).length - 1;
}

function getEditorTopLine() {
  return getEditorTopLinePosition().line;
}

function getEditorTopLinePosition() {
  const metrics = getEditorLineMetrics();
  const scrollTop = elements.editor.scrollTop;
  let low = 0;
  let high = metrics.tops.length - 1;
  let result = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (metrics.tops[middle] <= scrollTop + 1) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const lineTop = metrics.tops[result] || 0;
  const lineBottom = metrics.bottoms[result] || lineTop + getEditorLineHeight();
  return {
    line: result,
    progress: clamp((scrollTop - lineTop) / Math.max(1, lineBottom - lineTop), 0, 1)
  };
}

function getEditorLineHeight() {
  return parseFloat(getComputedStyle(elements.editor).lineHeight) || 24;
}

function getEditorLineTop(lineIndex) {
  const metrics = getEditorLineMetrics();
  const safeIndex = Math.min(Math.max(0, lineIndex), metrics.tops.length - 1);
  return metrics.tops[safeIndex] || 0;
}

function getEditorLineMetrics() {
  const editor = elements.editor;
  const styles = getComputedStyle(editor);
  const cacheKey = [
    editor.value,
    editor.clientWidth,
    styles.font,
    styles.lineHeight,
    styles.padding,
    styles.tabSize,
    styles.whiteSpace,
    styles.overflowWrap,
    styles.wordBreak
  ].join("\u0001");

  if (editorLineMetricsCache?.key === cacheKey) return editorLineMetricsCache;

  const mirror = document.createElement("div");
  mirror.style.position = "fixed";
  mirror.style.left = "-10000px";
  mirror.style.top = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${editor.clientWidth}px`;
  mirror.style.padding = styles.padding;
  mirror.style.border = styles.border;
  mirror.style.font = styles.font;
  mirror.style.lineHeight = styles.lineHeight;
  mirror.style.letterSpacing = styles.letterSpacing;
  mirror.style.tabSize = styles.tabSize;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = styles.overflowWrap === "normal" ? "break-word" : styles.overflowWrap;
  mirror.style.wordBreak = styles.wordBreak;

  const lines = editor.value.split(/\r?\n/);
  const lineHeight = getEditorLineHeight();
  const lineElements = lines.map((line) => {
    const element = document.createElement("div");
    element.textContent = line || "\u200B";
    element.style.minHeight = `${lineHeight}px`;
    mirror.appendChild(element);
    return element;
  });

  document.body.appendChild(mirror);
  const mirrorTop = mirror.getBoundingClientRect().top;
  const tops = lineElements.map((element) => element.getBoundingClientRect().top - mirrorTop);
  const bottoms = lineElements.map((element) => element.getBoundingClientRect().bottom - mirrorTop);
  mirror.remove();

  editorLineMetricsCache = { key: cacheKey, tops, bottoms };
  return editorLineMetricsCache;
}

function invalidateEditorLineMetrics() {
  editorLineMetricsCache = null;
}

function startResize(event) {
  const target = event.currentTarget;
  const mode = target.dataset.resizer;
  const startX = event.clientX;
  const workspaceWidth = elements.workspace.getBoundingClientRect().width;
  const startTree = document.querySelector(".tree-panel").getBoundingClientRect().width;
  const startToc = document.querySelector(".toc-panel").getBoundingClientRect().width;
  const startEditor = document.querySelector(".editor-panel").getBoundingClientRect().width;

  target.classList.add("dragging");
  target.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    const delta = moveEvent.clientX - startX;
    if (mode === "tree") {
      document.documentElement.style.setProperty("--tree-width", `${clamp(startTree + delta, 190, 440)}px`);
    }
    if (mode === "toc") {
      document.documentElement.style.setProperty("--toc-width", `${clamp(startToc + delta, 150, 360)}px`);
    }
    if (mode === "editor") {
      document.documentElement.style.setProperty("--editor-width", `${clamp(startEditor + delta, 300, workspaceWidth - 600)}px`);
    }
  };

  const up = () => {
    target.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function showPromptDialog(title, message, value, placeholder = "") {
  elements.dialogTitle.textContent = title;
  elements.dialogMessage.textContent = message;
  elements.dialogInput.value = value;
  elements.dialogInput.placeholder = placeholder;
  elements.dialogBackdrop.classList.add("open");
  elements.dialogBackdrop.setAttribute("aria-hidden", "false");
  refreshIcons();
  setTimeout(() => {
    elements.dialogInput.focus();
    elements.dialogInput.select();
  }, 0);
  return new Promise((resolve) => {
    dialogResolver = resolve;
  });
}

function closeDialog(value) {
  elements.dialogBackdrop.classList.remove("open");
  elements.dialogBackdrop.setAttribute("aria-hidden", "true");
  if (dialogResolver) dialogResolver(value?.trim() || null);
  dialogResolver = null;
}

function extractHeadings(markdown) {
  const counts = new Map();
  return markdown.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) return [];
    const text = stripMarkdown(match[2]);
    const base = slugify(text) || `heading-${index + 1}`;
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    return [{
      level: match[1].length,
      text,
      id: count ? `${base}-${count + 1}` : base,
      lineIndex: index,
      rendered: false
    }];
  });
}

function findNodeByPath(node, path) {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children) {
    const match = findNodeByPath(child, path);
    if (match) return match;
  }
  return null;
}

function findFirstPage(node) {
  if (node.type === "page") return node;
  for (const child of node.children) {
    const match = findFirstPage(child);
    if (match) return match;
  }
  return null;
}

function refreshIcons() {
  if (window.lucide) lucide.createIcons();
  setEditorEnabled(Boolean(selectedPageNode));
}

function stripMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*>#~]/g, "")
    .trim();
}

function stripHtml(text) {
  const template = document.createElement("template");
  template.innerHTML = text;
  return template.content.textContent || "";
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]+/gu, "");
}

function isExternalUrl(url) {
  return /^(https?:|data:|blob:|mailto:|#)/i.test(url || "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

initialize();
