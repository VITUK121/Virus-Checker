document.getElementById('uploadBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('fileInput');
    const status = document.getElementById('uploadStatus');
    const results = document.getElementById('results');

    if (fileInput.files.length === 0) {
        status.innerText = "Будь ласка, оберіть файл.";
        return;
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    status.innerText = "Завантаження та відправка в чергу...";
    results.innerText = "Сканування в процесі...";

    try {
        // Звертаємося до NestJS API (порт 3000 в docker-compose)
        const response = await fetch('http://localhost:3000/scan', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        status.innerText = "Файл успішно відправлено на перевірку!";
        results.innerHTML = `
            <p><strong>ID завдання:</strong> ${data.taskId}</p>
            <p><strong>Файл:</strong> ${data.filename}</p>
            <p><em>В реальній системі тут буде WebSocket або Polling для отримання статусу.</em></p>
        `;
    } catch (error) {
        status.innerText = "Помилка з'єднання з API.";
        console.error(error);
    }
});