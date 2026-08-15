const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const fileSelectedName = document.getElementById('fileSelectedName');
const dropText = document.getElementById('dropText');
const uploadBtn = document.getElementById('uploadBtn');
const uploadStatus = document.getElementById('uploadStatus');
const resultsContainer = document.getElementById('resultsContainer');

let selectedFile = null;
let pollingInterval = null;

// Handle file selection
fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
        handleSelectedFile(e.target.files[0]);
    }
});

// Drag & drop listeners
['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dragover');
    });
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
    });
});

dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
        fileInput.files = dt.files;
        handleSelectedFile(dt.files[0]);
    }
});

function handleSelectedFile(file) {
    selectedFile = file;
    fileSelectedName.innerText = `📄 ${file.name} (${formatBytes(file.size)})`;
    dropText.style.display = 'none';
    uploadBtn.disabled = false;
    uploadStatus.innerText = '';
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Upload & Scan button
uploadBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    // Reset previous polling
    if (pollingInterval) clearInterval(pollingInterval);

    uploadBtn.disabled = true;
    uploadStatus.innerText = '📤 Завантаження файлу на сервер...';
    
    renderState('pending', {
        title: 'Сканування запущено...',
        filename: selectedFile.name,
        details: 'Очікування висновку від антивірусного ядра ClamAV...'
    });

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
        const apiBase = `http://${window.location.hostname}:3000`;
        const response = await fetch(`${apiBase}/scan`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Помилка сервера: ${response.statusText}`);
        }

        const data = await response.json();

        // 1. If result was found in cache, display immediately!
        if (data.isCached && data.status !== 'PENDING') {
            uploadStatus.innerText = `⚡ Знайдено в кеші! (SHA-256: ${data.hash ? data.hash.slice(0, 12) + '...' : 'OK'})`;
            uploadBtn.disabled = false;

            if (data.status === 'CLEAN') {
                renderState('clean', {
                    title: 'Загроз не виявлено (Безпечний)',
                    taskId: data.taskId,
                    filename: data.filename || selectedFile.name,
                    hash: data.hash,
                    isCached: true,
                    details: data.details
                });
            } else if (data.status === 'INFECTED') {
                renderState('infected', {
                    title: 'УВАГА: Виявлено шкідливий файл!',
                    taskId: data.taskId,
                    filename: data.filename || selectedFile.name,
                    hash: data.hash,
                    isCached: true,
                    virusName: data.virusName || 'Невідома загроза',
                    details: data.details
                });
            } else {
                renderState('error', {
                    title: `Статус: ${data.status}`,
                    taskId: data.taskId,
                    filename: data.filename || selectedFile.name,
                    hash: data.hash,
                    isCached: true,
                    details: data.details
                });
            }
            return;
        }

        // 2. Cache miss -> start polling
        uploadStatus.innerText = `✅ Файл передано в чергу обробки. (ID: ${data.taskId.slice(0, 8)}...)`;
        startPolling(apiBase, data.taskId, data.filename, data.hash);
    } catch (error) {
        uploadStatus.innerText = `❌ Помилка завантаження: ${error.message}`;
        renderState('error', {
            title: 'Помилка звернення до API',
            details: error.message
        });
        uploadBtn.disabled = false;
    }
});

function startPolling(apiBase, taskId, filename, initialHash) {
    let attempts = 0;
    const maxAttempts = 60; // 60 attempts * 1s = 60 seconds timeout

    pollingInterval = setInterval(async () => {
        attempts++;
        try {
            const res = await fetch(`${apiBase}/scan/status/${taskId}`);
            if (!res.ok) {
                if (res.status === 404 && attempts < 5) return; // Allow small delay for task propagation
                throw new Error('Не вдалося отримати статус завдання');
            }

            const task = await res.json();
            const fileHash = task.hash || initialHash;

            if (task.status === 'PENDING') {
                renderState('pending', {
                    title: 'Сканування у процесі...',
                    taskId: task.taskId,
                    filename: filename,
                    hash: fileHash,
                    details: 'ClamAV перевіряє файл на наявність сигнатур шкідливого ПЗ...'
                });
            } else {
                // Completed!
                clearInterval(pollingInterval);
                uploadBtn.disabled = false;

                if (task.status === 'CLEAN') {
                    renderState('clean', {
                        title: 'Загроз не виявлено (Безпечний)',
                        taskId: task.taskId,
                        filename: task.filename || filename,
                        hash: fileHash,
                        details: task.details
                    });
                } else if (task.status === 'INFECTED') {
                    renderState('infected', {
                        title: 'УВАГА: Виявлено шкідливий файл!',
                        taskId: task.taskId,
                        filename: task.filename || filename,
                        hash: fileHash,
                        virusName: task.virusName || 'Невідома загроза',
                        details: task.details
                    });
                } else {
                    renderState('error', {
                        title: `Статус: ${task.status}`,
                        taskId: task.taskId,
                        filename: task.filename || filename,
                        hash: fileHash,
                        details: task.details
                    });
                }
            }
        } catch (err) {
            console.error('Polling error:', err);
            if (attempts >= maxAttempts) {
                clearInterval(pollingInterval);
                uploadBtn.disabled = false;
                renderState('error', {
                    title: 'Перевищено час очікування',
                    details: 'Не вдалося дочекатися результату від воркера сканування.'
                });
            }
        }
    }, 1000);
}

function renderState(type, data) {
    let badgeClass = type;
    let badgeText = type.toUpperCase();
    let icon = '🔍';

    if (type === 'clean') {
        icon = '✅';
        badgeText = 'Безпечний';
    } else if (type === 'infected') {
        icon = '🚨';
        badgeText = 'Загроза виявлена';
    } else if (type === 'pending') {
        icon = '<span class="spinner"></span>';
        badgeText = 'Перевірка...';
    } else if (type === 'error') {
        icon = '⚠️';
        badgeText = 'Помилка';
    }

    resultsContainer.innerHTML = `
        <div class="result-box ${type}">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                <span class="badge ${badgeClass}">${icon} ${badgeText}</span>
                <div style="display: flex; gap: 6px;">
                    ${data.isCached ? `<span style="font-size: 0.75rem; background: rgba(59, 130, 246, 0.2); color: #60a5fa; padding: 2px 8px; border-radius: 10px;">⚡ Cached</span>` : ''}
                    ${data.taskId ? `<span style="font-size: 0.75rem; color: var(--text-muted);">ID: ${data.taskId.slice(0, 8)}</span>` : ''}
                </div>
            </div>

            <div class="result-title">${data.title}</div>

            <div class="result-info">
                ${data.filename ? `<div><span>Файл:</span> <strong>${escapeHtml(data.filename)}</strong></div>` : ''}
                ${data.hash ? `<div><span>SHA-256:</span> <code style="font-size: 0.78rem; word-break: break-all; color: #94a3b8;">${escapeHtml(data.hash)}</code></div>` : ''}
                ${data.virusName ? `<div><span>Загроза:</span> <strong style="color: var(--danger);">${escapeHtml(data.virusName)}</strong></div>` : ''}
            </div>

            ${data.details ? `<div class="raw-details">${escapeHtml(data.details)}</div>` : ''}
        </div>
    `;
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
