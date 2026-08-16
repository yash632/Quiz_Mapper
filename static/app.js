let questions = [];
let currentIndex = 0;
let userName = '';
let isQuizActive = false;

// Detailed results review state
let resultsQuestions = [];
let resultsAnswers = {};
let resultsPage = 0;


// DOM Elements
const welcomeView = document.getElementById('welcome-view');
const quizView = document.getElementById('quiz-view');
const blockedView = document.getElementById('blocked-view');
const completionView = document.getElementById('completion-view');

const usernameInput = document.getElementById('username');
const startBtn = document.getElementById('start-btn');

const displayNameSpan = document.getElementById('display-name');
const currentQIndexSpan = document.getElementById('current-q-index');
const totalQCountSpan = document.getElementById('total-q-count');
const progressBar = document.getElementById('progress-bar');
const qTopicDiv = document.getElementById('q-topic');
const qTextDiv = document.getElementById('q-text');
const optionsContainer = document.getElementById('options-container');

const blockReasonText = document.getElementById('block-reason-text');
const scoreVal = document.getElementById('score-val');
const scoreTotalVal = document.getElementById('score-total-val');
const finalPct = document.getElementById('final-pct');

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    checkStatus();
});

// Check Session Status on Server
async function checkStatus() {
    try {
        const res = await fetch('/api/status');
        const status = await res.json();

        if (status.blocked) {
            showView(blockedView);
            isQuizActive = false;
            return;
        }

        if (status.registered) {
            userName = status.name;
            displayNameSpan.textContent = userName;
            
            if (status.completed) {
                renderCompletion(status.score);
            } else {
                showView(quizView);
                isQuizActive = true;
                await loadQuestionsAndStart(status.answers || {});
            }
        } else {
            showView(welcomeView);
        }
    } catch (err) {
        console.error('Error fetching system status:', err);
    }
}

// Start Quiz Event
startBtn.addEventListener('click', async () => {
    const name = usernameInput.value.trim();
    if (!name) {
        alert('Please enter your name to begin the quiz!');
        return;
    }

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        if (res.status === 403) {
            showView(blockedView);
            isQuizActive = false;
            return;
        }

        const data = await res.json();
        if (res.ok) {
            userName = data.name;
            displayNameSpan.textContent = userName;
            showView(quizView);
            isQuizActive = true;
            await loadQuestionsAndStart({});
        } else {
            alert(data.error || 'Registration failed');
        }
    } catch (err) {
        console.error('Registration failed:', err);
    }
});

// Load Questions and Start Tracking
async function loadQuestionsAndStart(resumeAnswers) {
    try {
        const res = await fetch('/api/questions');
        questions = await res.json();
        totalQCountSpan.textContent = questions.length;
        scoreTotalVal.textContent = questions.length;

        // Determine first unanswered index
        currentIndex = 0;
        for (let i = 0; i < questions.length; i++) {
            const qIdStr = String(questions[i].id);
            if (!resumeAnswers.hasOwnProperty(qIdStr)) {
                currentIndex = i;
                break;
            }
        }

        // If index exceeds count, quiz is finished
        if (currentIndex >= questions.length) {
            const finalStatusRes = await fetch('/api/status');
            const finalStatus = await finalStatusRes.json();
            renderCompletion(finalStatus.score || 0);
        } else {
            renderQuestion();
        }
    } catch (err) {
        console.error('Error loading questions:', err);
    }
}

// Render active question
function renderQuestion() {
    if (currentIndex >= questions.length) {
        isQuizActive = false;
        checkStatus();
        return;
    }

    const q = questions[currentIndex];
    currentQIndexSpan.textContent = currentIndex + 1;
    qTopicDiv.textContent = q.topic || 'General Python';

    // Highlight progress bar
    const percentage = (currentIndex / questions.length) * 100;
    progressBar.style.width = `${percentage}%`;

    // Process and format code snippets in question text
    qTextDiv.innerHTML = formatMarkdown(q.question);

    // Render options
    optionsContainer.innerHTML = '';
    q.options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.innerHTML = `
            <span class="option-letter">${String.fromCharCode(65 + idx)}</span>
            <span class="option-text">${escapeHtml(opt)}</span>
        `;
        
        btn.addEventListener('click', () => submitAnswer(q.id, opt, btn));
        optionsContainer.appendChild(btn);
    });
}

// Submit chosen option instantly
async function submitAnswer(qId, answerText, clickedButton) {
    // Disable all options immediately to lock choice
    const buttons = optionsContainer.querySelectorAll('.option-btn');
    buttons.forEach(btn => {
        btn.classList.add('disabled');
    });
    clickedButton.classList.remove('disabled');
    clickedButton.classList.add('selected');

    try {
        const res = await fetch('/api/submit-answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question_id: qId, answer: answerText })
        });

        if (res.status === 403) {
            showView(blockedView);
            isQuizActive = false;
            return;
        }

        const data = await res.json();
        if (res.ok) {
            // Animate transition delay to let user see selection
            setTimeout(() => {
                currentIndex++;
                if (data.completed) {
                    isQuizActive = false;
                    renderCompletion(data.score);
                } else {
                    renderQuestion();
                }
            }, 800);
        } else {
            alert(data.error || 'Failed to submit answer');
            buttons.forEach(btn => btn.classList.remove('disabled'));
            clickedButton.classList.remove('selected');
        }
    } catch (err) {
        console.error('Submission failed:', err);
    }
}

// Show Completion screen
function renderCompletion(score) {
    showView(completionView);
    isQuizActive = false;
    
    scoreVal.textContent = score;
    
    // Fetch and render the detailed review sheet
    fetchResultsAndRender();
}

// Swap View Layouts
function showView(viewElement) {
    document.querySelectorAll('.view').forEach(v => {
        v.classList.remove('active');
    });
    viewElement.classList.add('active');
}

// Helper: escape HTML
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Helper: Custom code block formatter
function formatMarkdown(text) {
    // Escape standard content outside code blocks safely
    const parts = text.split(/```python([\s\S]*?)```/g);
    
    let result = '';
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            // Code block parts - process with python syntax highlighting
            result += `<pre><code class="python">${highlightPython(parts[i])}</code></pre>`;
        } else {
            // Plain text - convert newlines to <br>
            result += escapeHtml(parts[i]).replace(/\n/g, '<br>');
        }
    }
    return result;
}

// Regex-based lightweight syntax highlighter
function highlightPython(code) {
    let cleanCode = escapeHtml(code.trim());
    
    const tokenRegex = /(#[^\n]*)|(&quot;.*?&quot;|&#039;.*?&#039;)|\b(def|class|if|else|elif|for|in|while|return|try|except|finally|import|from|as|is|and|or|not|pass|lambda|nonlocal|global)\b|\b(print|sum|len|range|any|all|int|str|list|dict|tuple|set|frozenset|append)\b|\b(\d+)\b/g;

    return cleanCode.replace(tokenRegex, (match, comment, string, keyword, builtin, number) => {
        if (comment) return `<span class="token comment">${comment}</span>`;
        if (string) return `<span class="token string">${string}</span>`;
        if (keyword) return `<span class="token keyword">${keyword}</span>`;
        if (builtin) return `<span class="token builtin">${builtin}</span>`;
        if (number) return `<span class="token number">${number}</span>`;
        return match;
    });
}

// --- Anti-Cheat Tab Switching Listeners ---

async function flagCheating(reason) {
    if (!isQuizActive) return;
    
    isQuizActive = false;
    blockReasonText.textContent = reason;
    showView(blockedView);
    
    try {
        await fetch('/api/cheat-detected', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });
    } catch (err) {
        console.error('Failed to report cheating event:', err);
    }
}

// Listen for tab switching
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && isQuizActive) {
        flagCheating('Tab switched (Page hidden)');
    }
});

// Listen for focus loss (e.g., clicking on another window)
window.addEventListener('blur', () => {
    if (isQuizActive) {
        flagCheating('Focus lost (Window blurred)');
    }
});

// --- Detailed Results Review sheet rendering logic ---

async function fetchResultsAndRender() {
    try {
        const res = await fetch('/api/results');
        if (!res.ok) return;
        const data = await res.json();
        
        resultsQuestions = data.questions;
        resultsAnswers = data.answers;
        resultsPage = 0;
        
        // Dynamically compute score ratio and percentage
        const score = parseInt(scoreVal.textContent) || 0;
        scoreTotalVal.textContent = resultsQuestions.length;
        const pct = Math.round((score / resultsQuestions.length) * 100);
        finalPct.textContent = `${pct}%`;
        
        const container = document.getElementById('results-breakdown-container');
        if (container) {
            container.style.display = 'block';
        }
        renderUserResultsSheet();
    } catch (err) {
        console.error('Error fetching quiz results:', err);
    }
}

function renderUserResultsSheet() {
    const grid = document.getElementById('user-results-grid');
    const pagination = document.getElementById('user-results-pagination');
    if (!grid || !pagination) return;
    
    if (resultsQuestions.length === 0) {
        grid.innerHTML = '<p>Loading results details...</p>';
        return;
    }
    
    const itemsPerPage = 10;
    const startIdx = resultsPage * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, resultsQuestions.length);
    const totalPages = Math.ceil(resultsQuestions.length / itemsPerPage);
    
    const pageQuestions = resultsQuestions.slice(startIdx, endIdx);
    
    let html = '';
    pageQuestions.forEach(q => {
        const qIdStr = String(q.id);
        const answered = resultsAnswers.hasOwnProperty(qIdStr);
        const choice = answered ? resultsAnswers[qIdStr] : null;
        
        html += `
            <div class="detail-row">
                <div class="detail-q">
                    <strong>Q${q.id}:</strong> ${formatMarkdown(q.question)}
                </div>
                <div class="detail-ans-row">
        `;

        q.options.forEach(opt => {
            const isCorrect = (opt.trim() === q.correct.trim());
            const isSelected = (choice !== null && opt.trim() === choice.trim());
            
            let statusClass = 'unanswered';
            let labelSuffix = '';

            if (isSelected) {
                statusClass = isCorrect ? 'correct' : 'selected';
                labelSuffix = ' (Your Choice)';
            } else if (isCorrect) {
                statusClass = 'correct';
                labelSuffix = ' (Correct Answer)';
            }

            html += `<span class="ans-indicator ${statusClass}">${escapeHtml(opt)}${labelSuffix}</span>`;
        });

        if (!answered) {
            html += `<span class="ans-indicator selected" style="background: rgba(245, 158, 11, 0.1); border-color: rgba(245, 158, 11, 0.4); color: #fef08a;">Unanswered</span>`;
        }

        html += `
                </div>
            </div>
        `;
    });
    
    grid.innerHTML = html;
    
    // Render pagination
    if (totalPages > 1) {
        pagination.innerHTML = `
            <div style="font-size: 0.9rem; color: var(--text-secondary);">
                Showing ${startIdx + 1}-${endIdx} of ${resultsQuestions.length} Questions
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn" style="padding: 8px 16px; font-size: 0.85rem; width: auto; background: ${resultsPage === 0 ? 'rgba(255,255,255,0.05)' : 'var(--accent-glow)'}; cursor: ${resultsPage === 0 ? 'not-allowed' : 'pointer'};" ${resultsPage === 0 ? 'disabled' : ''} onclick="changeUserResultsPage(-1)">
                    ◀ Prev
                </button>
                <button class="btn" style="padding: 8px 16px; font-size: 0.85rem; width: auto; background: ${resultsPage === totalPages - 1 ? 'rgba(255,255,255,0.05)' : 'var(--accent-glow)'}; cursor: ${resultsPage === totalPages - 1 ? 'not-allowed' : 'pointer'};" ${resultsPage === totalPages - 1 ? 'disabled' : ''} onclick="changeUserResultsPage(1)">
                    Next ▶
                </button>
            </div>
        `;
    } else {
        pagination.innerHTML = '';
    }
}

window.changeUserResultsPage = function(delta) {
    const totalPages = Math.ceil(resultsQuestions.length / 10);
    const newPage = resultsPage + delta;
    if (newPage >= 0 && newPage < totalPages) {
        resultsPage = newPage;
        renderUserResultsSheet();
        // Smooth scroll to top of results container
        document.getElementById('results-breakdown-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
};

