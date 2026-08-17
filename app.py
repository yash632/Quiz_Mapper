import os
import json
import sqlite3
import tempfile
import threading
from flask import Flask, request, jsonify, send_from_directory

file_lock = threading.Lock()


app = Flask(__name__, static_folder='static')

DB_PATH = 'db.sqlite'
QUESTIONS_PATH = 'questions.json'

ADMIN_PASSCODE = os.environ.get('ADMIN_PASSCODE', 'yash@root')
print("*" * 60)
print(f" SECURITY WARNING: ADMIN PASSCODE IS SET TO: {ADMIN_PASSCODE}")
print(" USE THIS PASSCODE TO LOG IN TO THE /admin PAGE")
print("*" * 60)

def check_admin_auth():
    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '):
        return False
    token = auth_header.split('Bearer ')[1].strip()
    return token == ADMIN_PASSCODE


def init_db():
    """Initializes the database schema if tables do not exist."""
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        
        # Table to store user quiz submissions (ACID compliant)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                answers TEXT NOT NULL, -- JSON string mapping question ID to chosen option
                score INTEGER DEFAULT 0,
                completed INTEGER DEFAULT 0, -- 0 = active, 1 = completed
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Table to store blocked IPs due to tab switching
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS blocked_ips (
                ip_address TEXT PRIMARY KEY,
                name TEXT,
                reason TEXT,
                blocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        conn.commit()

# Run database initialization
init_db()

def get_db_connection():
    """Returns a new SQLite connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def get_client_ip():
    """Extracts client IP address, supporting proxy setups."""
    if request.headers.get('X-Forwarded-For'):
        # In case of multiple proxies, take the first IP
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    return request.remote_addr

def is_ip_blocked(ip):
    """Checks if an IP address is blocked."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT 1 FROM blocked_ips WHERE ip_address = ?', (ip,))
        return cursor.fetchone() is not None

def load_questions():
    """Loads all questions from questions.json."""
    if not os.path.exists(QUESTIONS_PATH):
        return []
    with open(QUESTIONS_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

# Middleware or decorator to check IP status
@app.before_request
def check_block_status():
    # Allow serving static files and checking block status itself, plus admin unblocking
    if request.path.startswith('/static') or request.path in ['/api/status', '/api/admin/unblock', '/api/admin/dashboard', '/admin', '/api/admin/clear-data']:
        return None
        
    client_ip = get_client_ip()
    if is_ip_blocked(client_ip):
        return jsonify({
            'error': 'Forbidden',
            'message': 'Your IP address has been blocked due to tab switching/cheating detection.',
            'blocked': True
        }), 403

# HTML Views
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/admin')
def admin():
    return send_from_directory('static', 'admin.html')

# API Endpoints
@app.route('/api/status', methods=['GET'])
def status():
    """Returns whether the current IP is blocked or has an active session."""
    client_ip = get_client_ip()
    blocked = is_ip_blocked(client_ip)
    
    if blocked:
        return jsonify({'blocked': True})
        
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            'SELECT name, score, completed, answers, id FROM submissions WHERE ip_address = ? ORDER BY id DESC LIMIT 1',
            (client_ip,)
        )
        row = cursor.fetchone()
        
    if row:
        return jsonify({
            'blocked': False,
            'registered': True,
            'name': row['name'],
            'completed': bool(row['completed']),
            'score': row['score'],
            'answers': json.loads(row['answers'])
        })
    
    return jsonify({
        'blocked': False,
        'registered': False
    })

@app.route('/api/questions', methods=['GET'])
def get_questions():
    """Fetches questions but strips out correct answers to prevent inspection cheating."""
    questions = load_questions()
    safe_questions = []
    for q in questions:
        # Create a copy and omit 'correct' field
        sq = {
            'id': q['id'],
            'question': q['question'],
            'options': q['options'],
            'topic': q.get('topic', 'General')
        }
        safe_questions.append(sq)
    return jsonify(safe_questions)

@app.route('/api/register', methods=['POST'])
def register():
    """Registers a user for the quiz session."""
    client_ip = get_client_ip()
    if is_ip_blocked(client_ip):
        return jsonify({'error': 'Blocked IP'}), 403
        
    data = request.get_json() or {}
    name = data.get('name', '').strip()
    
    if not name:
        return jsonify({'error': 'Name is required'}), 400
        
    with get_db_connection() as conn:
        cursor = conn.cursor()
        
        # Check if user already registered under this IP
        cursor.execute('SELECT name, completed FROM submissions WHERE ip_address = ? ORDER BY id DESC LIMIT 1', (client_ip,))
        row = cursor.fetchone()
        
        if row:
            # If already registered and not completed, resume. If completed, return status.
            return jsonify({
                'message': 'Registration active',
                'name': row['name'],
                'completed': bool(row['completed'])
            })
            
        # Create new submission entry
        cursor.execute(
            'INSERT INTO submissions (name, ip_address, answers, score, completed) VALUES (?, ?, ?, ?, ?)',
            (name, client_ip, json.dumps({}), 0, 0)
        )
        conn.commit()
        
    return jsonify({
        'message': 'Registered successfully',
        'name': name,
        'completed': False
    })

@app.route('/api/submit-answer', methods=['POST'])
def submit_answer():
    """Submits a single answer, checks it on the server, updates progress and score."""
    client_ip = get_client_ip()
    if is_ip_blocked(client_ip):
        return jsonify({'error': 'Blocked IP'}), 403
        
    data = request.get_json() or {}
    question_id = str(data.get('question_id'))
    answer = data.get('answer')
    
    if not question_id or answer is None:
        return jsonify({'error': 'Invalid request parameters'}), 400
        
    # Get active session
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            'SELECT id, name, answers, score, completed FROM submissions WHERE ip_address = ? ORDER BY id DESC LIMIT 1',
            (client_ip,)
        )
        row = cursor.fetchone()
        
        if not row:
            return jsonify({'error': 'User not registered'}), 401
            
        if row['completed']:
            return jsonify({'error': 'Quiz already completed'}), 400
            
        submission_id = row['id']
        answers = json.loads(row['answers'])
        current_score = row['score']
        
        # Check if already answered
        if question_id in answers:
            return jsonify({'error': 'Question already answered'}), 400
            
        # Verify answer
        questions = load_questions()
        question = next((q for q in questions if str(q['id']) == question_id), None)
        
        if not question:
            return jsonify({'error': 'Question not found'}), 404
            
        # Update answers dictionary
        answers[question_id] = answer
        
        # Check correctness
        is_correct = (str(question['correct']).strip() == str(answer).strip())
        new_score = current_score + (1 if is_correct else 0)
        
        # Determine completion
        total_questions = len(questions)
        completed = 1 if len(answers) >= total_questions else 0
        
        # Save atomically
        cursor.execute(
            'UPDATE submissions SET answers = ?, score = ?, completed = ? WHERE id = ?',
            (json.dumps(answers), new_score, completed, submission_id)
        )
        conn.commit()
        
    return jsonify({
        'success': True,
        'score': new_score,
        'completed': bool(completed),
        'total': total_questions
    })

@app.route('/api/cheat-detected', methods=['POST'])
def cheat_detected():
    """Blocks an IP immediately if cheating/tab-switching is detected."""
    client_ip = get_client_ip()
    data = request.get_json() or {}
    reason = data.get('reason', 'Tab switch / focus loss detected')
    
    # Try to find current registered user name
    name = "Unknown"
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT name FROM submissions WHERE ip_address = ? ORDER BY id DESC LIMIT 1', (client_ip,))
        row = cursor.fetchone()
        if row:
            name = row['name']
            
        # Add to blocked IPs (INSERT OR IGNORE to prevent key conflicts)
        cursor.execute(
            'INSERT OR IGNORE INTO blocked_ips (ip_address, name, reason) VALUES (?, ?, ?)',
            (client_ip, name, reason)
        )
        conn.commit()
        
    return jsonify({
        'success': True,
        'message': 'IP blocked'
    })

@app.route('/api/admin/dashboard', methods=['GET'])
def admin_dashboard():
    """Returns analytics, details, and logs for administrator view."""
    if not check_admin_auth():
        return jsonify({'error': 'Unauthorized'}), 401
        
    with get_db_connection() as conn:
        cursor = conn.cursor()
        
        # Submissions
        cursor.execute('SELECT * FROM submissions ORDER BY created_at DESC')
        submissions_rows = cursor.fetchall()
        submissions = []
        for row in submissions_rows:
            submissions.append({
                'id': row['id'],
                'name': row['name'],
                'ip_address': row['ip_address'],
                'answers': json.loads(row['answers']),
                'score': row['score'],
                'completed': bool(row['completed']),
                'created_at': row['created_at']
            })
            
        # Blocked IPs
        cursor.execute('SELECT * FROM blocked_ips ORDER BY blocked_at DESC')
        blocked_rows = cursor.fetchall()
        blocked_ips = []
        for row in blocked_rows:
            blocked_ips.append({
                'ip_address': row['ip_address'],
                'name': row['name'],
                'reason': row['reason'],
                'blocked_at': row['blocked_at']
            })
            
        # Stats
        total_registered = len(submissions)
        total_completed = sum(1 for s in submissions if s['completed'])
        avg_score = (sum(s['score'] for s in submissions) / total_registered) if total_registered > 0 else 0
        total_blocked = len(blocked_ips)
        
        # Load questions to send to admin for comparative view
        questions = load_questions()
        
    return jsonify({
        'stats': {
            'total_registered': total_registered,
            'total_completed': total_completed,
            'avg_score': round(avg_score, 2),
            'total_blocked': total_blocked
        },
        'submissions': submissions,
        'blocked': blocked_ips,
        'questions': questions
    })

@app.route('/api/admin/unblock', methods=['POST'])
def admin_unblock():
    """Removes an IP from the blocklist."""
    if not check_admin_auth():
        return jsonify({'error': 'Unauthorized'}), 401
        
    data = request.get_json() or {}
    ip_to_unblock = data.get('ip')
    
    if not ip_to_unblock:
        return jsonify({'error': 'IP address is required'}), 400
        
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM blocked_ips WHERE ip_address = ?', (ip_to_unblock,))
        conn.commit()
        
    return jsonify({'success': True, 'message': f'IP {ip_to_unblock} has been unblocked.'})

@app.route('/api/admin/clear-data', methods=['POST'])
def admin_clear_data():
    """Resets the application database."""
    if not check_admin_auth():
        return jsonify({'error': 'Unauthorized'}), 401
        
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM submissions')
        cursor.execute('DELETE FROM blocked_ips')
        conn.commit()
    return jsonify({'success': True, 'message': 'All data has been cleared.'})

@app.route('/api/admin/add-question', methods=['POST'])
def add_question():
    """Safely adds a new question to questions.json using locking and atomic replacement."""
    if not check_admin_auth():
        return jsonify({'error': 'Unauthorized'}), 401
        
    data = request.get_json() or {}
    topic = data.get('topic', '').strip()
    question = data.get('question', '').strip()
    options = data.get('options', [])
    correct_idx = data.get('correct_idx', '').strip()
    
    if not topic or not question or len(options) != 4 or correct_idx not in ['A', 'B', 'C', 'D']:
        return jsonify({'error': 'All fields are required, and there must be exactly 4 options.'}), 400
        
    idx_map = {'A': 0, 'B': 1, 'C': 2, 'D': 3}
    correct_answer = options[idx_map[correct_idx]].strip()
    
    with file_lock:
        questions = load_questions()
        next_id = max([q['id'] for q in questions]) + 1 if questions else 1
        
        new_q = {
            'id': next_id,
            'topic': topic,
            'question': question,
            'options': [opt.strip() for opt in options],
            'correct': correct_answer
        }
        questions.append(new_q)
        
        # Atomic file write to avoid file truncation/corruption on concurrent reads
        temp_path = None
        try:
            dir_name = os.path.dirname(os.path.abspath(QUESTIONS_PATH))
            temp_fd, temp_path = tempfile.mkstemp(dir=dir_name, prefix='questions_', suffix='.json')
            with os.fdopen(temp_fd, 'w', encoding='utf-8') as temp_f:
                json.dump(questions, temp_f, indent=2, ensure_ascii=False)
            os.replace(temp_path, QUESTIONS_PATH)
        except Exception as e:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)
            return jsonify({'error': f'Failed to write to file safely: {str(e)}'}), 500
            
    return jsonify({
        'success': True,
        'message': 'Question added successfully',
        'question': new_q
    })

@app.route('/api/results', methods=['GET'])
def get_results():
    """Returns the user's submitted answers and the questions (with correct options) once completed."""
    client_ip = get_client_ip()
    if is_ip_blocked(client_ip):
        return jsonify({'error': 'Blocked IP'}), 403
        
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            'SELECT answers, completed FROM submissions WHERE ip_address = ? ORDER BY id DESC LIMIT 1',
            (client_ip,)
        )
        row = cursor.fetchone()
        
    if not row:
        return jsonify({'error': 'No quiz session found for your IP address.'}), 404
        
    if not row['completed']:
        return jsonify({'error': 'You must complete the quiz first to view results.'}), 400
        
    user_answers = json.loads(row['answers'])
    questions = load_questions() # Loads questions including 'correct' field
    
    return jsonify({
        'answers': user_answers,
        'questions': questions
    })

@app.route('/api/admin/delete-submission', methods=['POST'])
def delete_submission():
    """Admin endpoint to delete a submission record completely."""
    if not check_admin_auth():
        return jsonify({'error': 'Unauthorized'}), 401
        
    data = request.get_json() or {}
    sub_id = data.get('id')
    
    if not sub_id:
        return jsonify({'error': 'Submission ID is required'}), 400
        
    with get_db_connection() as conn:
        cursor = conn.cursor()
        
        # Get IP address before deleting to remove block if any
        cursor.execute('SELECT ip_address FROM submissions WHERE id = ?', (sub_id,))
        row = cursor.fetchone()
        
        if row:
            ip_addr = row['ip_address']
            # Delete block
            cursor.execute('DELETE FROM blocked_ips WHERE ip_address = ?', (ip_addr,))
            
        cursor.execute('DELETE FROM submissions WHERE id = ?', (sub_id,))
        conn.commit()
        
    return jsonify({'success': True, 'message': 'Submission deleted successfully.'})

@app.route('/api/admin/retake-submission', methods=['POST'])
def retake_submission():
    """Admin endpoint to reset a submission and unblock the IP, allowing them to retake the quiz."""
    if not check_admin_auth():
        return jsonify({'error': 'Unauthorized'}), 401
        
    data = request.get_json() or {}
    sub_id = data.get('id')
    
    if not sub_id:
        return jsonify({'error': 'Submission ID is required'}), 400
        
    with get_db_connection() as conn:
        cursor = conn.cursor()
        
        # Get IP address before resetting
        cursor.execute('SELECT ip_address FROM submissions WHERE id = ?', (sub_id,))
        row = cursor.fetchone()
        
        if not row:
            return jsonify({'error': 'Submission not found'}), 404
            
        ip_addr = row['ip_address']
        
        # Reset submission stats
        cursor.execute(
            "UPDATE submissions SET answers = '{}', score = 0, completed = 0 WHERE id = ?",
            (sub_id,)
        )
        
        # Delete IP from blocked IPs list to allow them access
        cursor.execute('DELETE FROM blocked_ips WHERE ip_address = ?', (ip_addr,))
        
        conn.commit()
        
    return jsonify({'success': True, 'message': 'Submission reset. User is allowed to retake.'})




if __name__ == '__main__':
    # Running local server
    app.run(host='0.0.0.0', port=8080, debug=True)
