import pika
import json
import os
import subprocess

RABBITMQ_URL = os.environ.get('RABBITMQ_URL', 'amqp://localhost')

def scan_file(file_path):
    print(f"[*] Сканування файлу: {file_path}")
    try:
        # Запускаємо clamscan. В реалі краще використовувати clamdscan (демон)
        result = subprocess.run(['clamscan', file_path], stdout=subprocess.PIPE, text=True)
        return result.stdout
    except Exception as e:
        return str(e)

def callback(ch, method, properties, body):
    data = json.loads(body)
    file_path = data.get('filePath')
    
    if os.path.exists(file_path):
        report = scan_file(file_path)
        print(f"[+] Результат для {data['taskId']}:\n{report}")
        # Тут зазвичай результат відправляється назад в чергу 'results_queue'
    else:
        print(f"[-] Помилка: Файл {file_path} не знайдено.")
        
    ch.basic_ack(delivery_tag=method.delivery_tag)

def main():
    # Парсимо URL з оточення
    parameters = pika.URLParameters(RABBITMQ_URL)
    
    # Вимикаємо heartbeats (значення 0), щоб сканування великих файлів 
    # не призводило до розриву з'єднання
    parameters.heartbeat = 0 
    
    connection = pika.BlockingConnection(parameters)
    channel = connection.channel()
    channel.queue_declare(queue='scan_queue', durable=True)
    
    print(' [*] Очікування завдань. Для виходу натисніть CTRL+C')
    # prefetch_count=1 гарантує, що воркер бере лише 1 файл за раз
    channel.basic_qos(prefetch_count=1)
    channel.basic_consume(queue='scan_queue', on_message_callback=callback)
    channel.start_consuming()

if __name__ == '__main__':
    main()