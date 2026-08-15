import pika
import json
import os
import re
import subprocess

RABBITMQ_URL = os.environ.get('RABBITMQ_URL', 'amqp://localhost')

def scan_file(file_path: str) -> dict:
    """
    Scans a file using ClamAV (clamscan).
    Return codes:
      0: Clean
      1: Infected (Extracts virus signature)
      2: Error
    """
    try:
        result = subprocess.run(
            ['clamscan', '--no-summary', file_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120
        )
        
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        return_code = result.returncode
        
        if return_code == 0:
            return {
                'status': 'CLEAN',
                'isInfected': False,
                'virusName': None,
                'details': stdout or 'No threats detected.'
            }
        elif return_code == 1:
            # Extract threat name (e.g., "/path/file: Eicar-Test-Signature FOUND")
            virus_match = re.search(r':\s+(.+)\s+FOUND', stdout)
            virus_name = virus_match.group(1) if virus_match else 'Unknown Threat'
            return {
                'status': 'INFECTED',
                'isInfected': True,
                'virusName': virus_name,
                'details': stdout
            }
        else:
            return {
                'status': 'ERROR',
                'isInfected': False,
                'virusName': None,
                'details': stderr or stdout or f'clamscan exited with code {return_code}'
            }
    except subprocess.TimeoutExpired:
        return {
            'status': 'TIMEOUT',
            'isInfected': False,
            'virusName': None,
            'details': 'Scan timed out after 120 seconds.'
        }

def callback(ch, method, properties, body):
    try:
        data = json.loads(body)
        task_id = data.get('taskId')
        file_path = data.get('filePath')
        original_name = data.get('originalName', os.path.basename(file_path) if file_path else 'file')
        
        file_hash = data.get('hash')
        
        print(f"\n[+] Received scan task [{task_id}] for file: {file_path} (Hash: {file_hash[:12] if file_hash else 'N/A'}...)")
        
        if not file_path or not os.path.exists(file_path):
            result = {
                'taskId': task_id,
                'filename': original_name,
                'hash': file_hash,
                'status': 'FILE_NOT_FOUND',
                'isInfected': False,
                'virusName': None,
                'details': f"File '{file_path}' does not exist on disk."
            }
            print(f"[-] Error: File not found -> {file_path}")
        else:
            scan_result = scan_file(file_path)
            result = {
                'taskId': task_id,
                'filename': original_name,
                'filePath': file_path,
                'hash': file_hash,
                **scan_result
            }
            
            if result['isInfected']:
                print(f"[!] THREAT DETECTED in [{task_id}]: {result['virusName']}")
            elif result['status'] == 'CLEAN':
                print(f"[✓] File [{task_id}] is CLEAN.")
            else:
                print(f"[-] Scan issue for [{task_id}]: {result['details']}")
                
        # Publish result to results_queue
        ch.queue_declare(queue='results_queue', durable=True)
        ch.basic_publish(
            exchange='',
            routing_key='results_queue',
            body=json.dumps(result),
            properties=pika.BasicProperties(
                delivery_mode=2  # Make message persistent
            )
        )
        print(f"[+] Result published to 'results_queue' for taskId: {task_id}")
        
    except Exception as e:
        print(f"[-] Failed to process message: {e}")
    finally:
        # Acknowledge the message so RabbitMQ removes it from the queue
        ch.basic_ack(delivery_tag=method.delivery_tag)

def main():
    print(f"[*] Connecting to RabbitMQ at: {RABBITMQ_URL}")
    parameters = pika.URLParameters(RABBITMQ_URL)
    
    # Disable heartbeats to prevent connection drops during long scans
    parameters.heartbeat = 0 
    
    connection = pika.BlockingConnection(parameters)
    channel = connection.channel()
    channel.queue_declare(queue='scan_queue', durable=True)
    channel.queue_declare(queue='results_queue', durable=True)
    
    print(' [*] Worker ready. Waiting for scan tasks. Press CTRL+C to exit.')
    channel.basic_qos(prefetch_count=1)
    channel.basic_consume(queue='scan_queue', on_message_callback=callback)
    channel.start_consuming()

if __name__ == '__main__':
    main()

