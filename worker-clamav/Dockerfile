FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y clamav clamav-daemon && \
    rm -rf /var/lib/apt/lists/*

RUN freshclam

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py .

# Запускаємо воркер
CMD ["python", "-u", "worker.py"]