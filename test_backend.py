import unittest
import os
import json
import sqlite3
import threading
from app import app, DB_PATH, init_db, get_db_connection

class QuizBackendTestCase(unittest.TestCase):
    def setUp(self):
        # Use a separate test database
        self.test_db_path = 'test_db.sqlite'
        import app as app_mod
        app_mod.DB_PATH = self.test_db_path
        app_mod.init_db()
        
        self.app = app.test_client()
        self.app.testing = True
        
        # Override headers helper to fake different IP addresses
        self.original_get_client_ip = app_mod.get_client_ip

    def tearDown(self):
        # Remove test database
        if os.path.exists(self.test_db_path):
            try:
                os.remove(self.test_db_path)
            except PermissionError:
                pass

    def test_questions_strip_correct_answers(self):
        """Ensures that the API strips correct answers for security."""
        response = self.app.get('/api/questions')
        self.assertEqual(response.status_code, 200)
        questions = json.loads(response.data)
        
        self.assertGreater(len(questions), 0)
        for q in questions:
            self.assertNotIn('correct', q)
            self.assertIn('id', q)
            self.assertIn('question', q)
            self.assertIn('options', q)

    def test_user_registration_and_status(self):
        """Test registration path and session checking."""
        # Check initial status
        response = self.app.get('/api/status')
        status = json.loads(response.data)
        self.assertFalse(status['blocked'])
        self.assertFalse(status['registered'])

        # Register user
        reg_response = self.app.post('/api/register', 
                                    data=json.dumps({'name': 'Test User'}),
                                    content_type='application/json')
        self.assertEqual(reg_response.status_code, 200)
        reg_data = json.loads(reg_response.data)
        self.assertEqual(reg_data['name'], 'Test User')

        # Check status again
        response = self.app.get('/api/status')
        status = json.loads(response.data)
        self.assertTrue(status['registered'])
        self.assertEqual(status['name'], 'Test User')
        self.assertFalse(status['completed'])

    def test_cheating_lockout(self):
        """Test that cheating detection locks the user out."""
        # Trigger cheat detection
        cheat_response = self.app.post('/api/cheat-detected',
                                      data=json.dumps({'reason': 'Tab switched'}),
                                      content_type='application/json')
        self.assertEqual(cheat_response.status_code, 200)

        # Confirm user is blocked on status check
        response = self.app.get('/api/status')
        status = json.loads(response.data)
        self.assertTrue(status['blocked'])

        # Confirm active requests block the user with 403 Forbidden
        reg_response = self.app.post('/api/register', 
                                    data=json.dumps({'name': 'Another User'}),
                                    content_type='application/json')
        self.assertEqual(reg_response.status_code, 403)

    def test_admin_dashboard_and_unblock(self):
        """Test administrative actions: unblocking users and listing dashboard statistics."""
        # Check unauthorized access returns 401
        unauth_response = self.app.get('/api/admin/dashboard')
        self.assertEqual(unauth_response.status_code, 401)

        # Add to blocklist
        self.app.post('/api/cheat-detected',
                      data=json.dumps({'reason': 'Tab blur'}),
                      content_type='application/json')
        
        # Get dashboard stats with authorization header
        import app as app_mod
        headers = {'Authorization': f'Bearer {app_mod.ADMIN_PASSCODE}'}
        dash_response = self.app.get('/api/admin/dashboard', headers=headers)
        self.assertEqual(dash_response.status_code, 200)
        data = json.loads(dash_response.data)
        self.assertEqual(data['stats']['total_blocked'], 1)
        self.assertGreater(len(data['blocked']), 0)
        blocked_ip = data['blocked'][0]['ip_address']

        # Unblock user IP with authorization header
        unblock_response = self.app.post('/api/admin/unblock',
                                        headers=headers,
                                        data=json.dumps({'ip': blocked_ip}),
                                        content_type='application/json')
        self.assertEqual(unblock_response.status_code, 200)

        # Check status again to verify unblocked
        response = self.app.get('/api/status')
        status = json.loads(response.data)
        self.assertFalse(status['blocked'])

    def test_concurrent_registrations(self):
        """Verifies transaction safety under simultaneous client threads."""
        import app as app_mod
        
        # We will spin up multiple threads making direct writes to the sqlite test db
        def register_worker(name, ip):
            try:
                conn = sqlite3.connect(self.test_db_path)
                cursor = conn.cursor()
                cursor.execute(
                    'INSERT INTO submissions (name, ip_address, answers, score, completed) VALUES (?, ?, ?, ?, ?)',
                    (name, ip, json.dumps({}), 0, 0)
                )
                conn.commit()
                conn.close()
            except Exception as e:
                self.fail(f"Database insertion failed under concurrency: {e}")

        threads = []
        for i in range(15):
            t = threading.Thread(target=register_worker, args=(f"Concurrent User {i}", f"192.168.1.{i}"))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Connect and verify counts
        conn = sqlite3.connect(self.test_db_path)
        cursor = conn.cursor()
        cursor.execute('SELECT COUNT(*) FROM submissions')
        count = cursor.fetchone()[0]
        conn.close()
        self.assertEqual(count, 15)

    def test_add_question(self):
        """Test adding questions via authorized endpoint."""
        # Unauthorized check
        payload = {
            'topic': 'Recursion',
            'question': 'What is the base case?',
            'options': ['Option A', 'Option B', 'Option C', 'Option D'],
            'correct_idx': 'A'
        }
        res = self.app.post('/api/admin/add-question', 
                            data=json.dumps(payload),
                            content_type='application/json')
        self.assertEqual(res.status_code, 401)

        # Authorized check
        import app as app_mod
        headers = {'Authorization': f'Bearer {app_mod.ADMIN_PASSCODE}'}
        original_questions_path = app_mod.QUESTIONS_PATH
        test_questions_path = 'test_questions.json'
        
        initial_q = [{
            'id': 1,
            'topic': 'Variables',
            'question': 'What is x?',
            'options': ['1', '2', '3', '4'],
            'correct': '1'
        }]
        with open(test_questions_path, 'w', encoding='utf-8') as f:
            json.dump(initial_q, f)
            
        app_mod.QUESTIONS_PATH = test_questions_path
        
        try:
            res = self.app.post('/api/admin/add-question',
                                headers=headers,
                                data=json.dumps(payload),
                                content_type='application/json')
            self.assertEqual(res.status_code, 200)
            data = json.loads(res.data)
            self.assertTrue(data['success'])
            self.assertEqual(data['question']['id'], 2)
            self.assertEqual(data['question']['correct'], 'Option A')
            
            with open(test_questions_path, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
            self.assertEqual(len(loaded), 2)
            self.assertEqual(loaded[1]['topic'], 'Recursion')
        finally:
            app_mod.QUESTIONS_PATH = original_questions_path
            if os.path.exists(test_questions_path):
                os.remove(test_questions_path)

if __name__ == '__main__':
    unittest.main()
