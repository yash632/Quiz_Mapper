let questionsList = [];
let submissionsCached = [];
let blockedCached = [];
let expandedSubmissions = new Set(); // Track expanded submission IDs

// Auth state
let adminPasscode = localStorage.getItem('admin_passcode') || '';

// DOM elements
const statRegistered = document.getElementById('stat-registered');
const statCompleted = document.getElementById('stat-completed');
const statAvg = document.getElementById('stat-avg');
const statBlocked = document.getElementById('stat-blocked');
const blockedListContainer = document.getElementById('blocked-list-container');
const submissionsListContainer = document.getElementById('submissions-list-container');
const blockedCountBadge = document.getElementById('blocked-count-badge');
const clearDbBtn = document.getElementById('clear-db-btn');

// Login modal elements
const adminLoginModal = document.getElementById('admin-login-modal');
const adminPasscodeInput = document.getElementById('admin-passcode-input');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const loginErrorMsg = document.getElementById('login-error-msg');

// Initial Load & Polling setup
window.addEventListener('DOMContentLoaded', () => {
    if (!adminPasscode) {
        showLoginModal();
    } else {
        fetchData();
        setInterval(fetchData, 3000); // Poll every 3 seconds
    }
});

// Setup auth overlay handlers
loginSubmitBtn.addEventListener('click', attemptLogin);
adminPasscodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') attemptLogin();
});

function showLoginModal() {
    adminLoginModal.classList.add('active');
    adminPasscodeInput.focus();
}

async function attemptLogin() {
    const inputPass = adminPasscodeInput.value.trim();
    if (!inputPass) return;

    try {
        const res = await fetch('/api/admin/dashboard', {
            headers: { 'Authorization': 'Bearer ' + inputPass }
        });
        
        if (res.ok) {
            // Authorized!
            adminPasscode = inputPass;
            localStorage.setItem('admin_passcode', adminPasscode);
            adminLoginModal.classList.remove('active');
            loginErrorMsg.style.display = 'none';
            adminPasscodeInput.value = '';
            
            // Start dashboard fetch and setup poll
            fetchData();
            setInterval(fetchData, 3000);
        } else {
            loginErrorMsg.style.display = 'block';
            adminPasscodeInput.focus();
        }
    } catch (err) {
        console.error('Login request failed:', err);
    }
}

// Fetch all dashboard stats from server
async function fetchData() {
    if (!adminPasscode) return;
    try {
        const res = await fetch('/api/admin/dashboard', {
            headers: { 'Authorization': 'Bearer ' + adminPasscode }
        });
        
        if (res.status === 401) {
            handleUnauthorized();
            return;
        }

        if (!res.ok) return;

        const data = await res.json();
        
        // Cache questions list
        questionsList = data.questions;
        
        // Update stats
        statRegistered.textContent = data.stats.total_registered;
        statCompleted.textContent = data.stats.total_completed;
        statAvg.textContent = `${data.stats.avg_score} / ${questionsList.length}`;
        statBlocked.textContent = data.stats.total_blocked;
        blockedCountBadge.textContent = data.stats.total_blocked;

        // Render Blocked list if content changed
        if (JSON.stringify(blockedCached) !== JSON.stringify(data.blocked)) {
            blockedCached = data.blocked;
            renderBlockedList();
        }

        // Render Submissions if content changed
        if (JSON.stringify(submissionsCached) !== JSON.stringify(data.submissions)) {
            submissionsCached = data.submissions;
            renderSubmissionsList();
        }
    } catch (err) {
        console.error('Error fetching admin data:', err);
    }
}

function handleUnauthorized() {
    adminPasscode = '';
    localStorage.removeItem('admin_passcode');
    showLoginModal();
}

// Render Blocked IP list
function renderBlockedList() {
    blockedListContainer.innerHTML = '';
    if (blockedCached.length === 0) {
        blockedListContainer.innerHTML = '<div class="no-data">No active suspensions.</div>';
        return;
    }

    blockedCached.forEach(item => {
        const div = document.createElement('div');
        div.className = 'blocked-item';
        div.innerHTML = `
            <div class="blocked-info">
                <h4>${escapeHtml(item.name || 'Unknown User')}</h4>
                <p>IP: ${item.ip_address}</p>
                <p style="color: var(--text-secondary); font-size: 0.8rem; margin-top: 4px;">Reason: ${escapeHtml(item.reason)}</p>
            </div>
            <button class="unblock-btn" onclick="unblockIp('${item.ip_address}')">Unblock</button>
        `;
        blockedListContainer.appendChild(div);
    });
}

// Unblock participant
async function unblockIp(ip) {
    if (!confirm(`Are you sure you want to unblock IP: ${ip}?`)) return;
    try {
        const res = await fetch('/api/admin/unblock', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + adminPasscode 
            },
            body: JSON.stringify({ ip })
        });
        
        if (res.status === 401) {
            handleUnauthorized();
            return;
        }

        if (res.ok) {
            fetchData();
        } else {
            alert('Failed to unblock IP');
        }
    } catch (err) {
        console.error('Error during unblock:', err);
    }
}

// Reset Database API action
clearDbBtn.addEventListener('click', async () => {
    if (!confirm('⚠️ WARNING: This will permanently delete all submissions and unblock all IPs. Do you want to proceed?')) return;
    try {
        const res = await fetch('/api/admin/clear-data', { 
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + adminPasscode }
        });

        if (res.status === 401) {
            handleUnauthorized();
            return;
        }

        if (res.ok) {
            expandedSubmissions.clear();
            fetchData();
            alert('Database has been reset.');
        } else {
            alert('Clear failed.');
        }
    } catch (err) {
        console.error('Clear failed:', err);
    }
});

// State to track pagination pages per submission card
let submissionPages = {};

// Render user submissions list
function renderSubmissionsList() {
    submissionsListContainer.innerHTML = '';
    if (submissionsCached.length === 0) {
        submissionsListContainer.innerHTML = '<div class="no-data">No registered participants yet.</div>';
        return;
    }

    submissionsCached.forEach(sub => {
        const item = document.createElement('div');
        const isExpanded = expandedSubmissions.has(sub.id);
        item.className = `submission-item ${isExpanded ? 'expanded' : ''}`;
        
        // Progress status badge
        const badgeClass = sub.completed ? 'completed' : 'active';
        const badgeLabel = sub.completed ? 'Completed' : 'In Progress';

        item.innerHTML = `
            <div class="submission-header" onclick="toggleExpand(${sub.id}, this)">
                <div class="sub-name">${escapeHtml(sub.name)}</div>
                <div class="sub-ip">${sub.ip_address}</div>
                <div class="sub-score">${sub.score} / ${questionsList.length}</div>
                <div>
                    <span class="badge ${badgeClass}">${badgeLabel}</span>
                    <span class="chevron" style="display: inline-block; margin-left: 10px;">▼</span>
                </div>
            </div>
            <div class="submission-details" id="details-container-${sub.id}">
                ${renderUserAnswers(sub)}
            </div>
        `;
        submissionsListContainer.appendChild(item);
    });
}

// Toggle detail drawer
window.toggleExpand = function(id, headerEl) {
    const parent = headerEl.parentElement;
    if (expandedSubmissions.has(id)) {
        expandedSubmissions.delete(id);
        parent.classList.remove('expanded');
    } else {
        expandedSubmissions.add(id);
        parent.classList.add('expanded');
    }
};

// Render detail overview of user options compared to correct keys with scroll & pagination support
function renderUserAnswers(sub) {
    if (questionsList.length === 0) return '<p>Loading questions details...</p>';
    
    const itemsPerPage = 10;
    const page = submissionPages[sub.id] || 0;
    const startIdx = page * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, questionsList.length);
    const totalPages = Math.ceil(questionsList.length / itemsPerPage);
    
    const pageQuestions = questionsList.slice(startIdx, endIdx);
    const userAnswers = sub.answers || {};

    let html = '<div class="submission-details-scroll">';
    html += '<div class="detail-grid">';
    
    pageQuestions.forEach(q => {
        const qIdStr = String(q.id);
        const answered = userAnswers.hasOwnProperty(qIdStr);
        const choice = answered ? userAnswers[qIdStr] : null;
        
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
                labelSuffix = ' (User Chosen)';
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
    html += '</div>'; // close detail-grid
    html += '</div>'; // close submission-details-scroll

    // Add Pagination controls
    if (totalPages > 1) {
        html += `
            <div class="pagination-controls" style="display: flex; justify-content: space-between; align-items: center; margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255, 255, 255, 0.05);">
                <div style="font-size: 0.9rem; color: var(--text-secondary);">
                    Showing ${startIdx + 1}-${endIdx} of ${questionsList.length} Questions
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="unblock-btn" style="padding: 6px 12px; font-size: 0.85rem; background: ${page === 0 ? 'rgba(255,255,255,0.05)' : 'var(--accent)'}; cursor: ${page === 0 ? 'not-allowed' : 'pointer'};" ${page === 0 ? 'disabled' : ''} onclick="changeSubPage(${sub.id}, -1)">
                        ◀ Prev
                    </button>
                    <button class="unblock-btn" style="padding: 6px 12px; font-size: 0.85rem; background: ${page === totalPages - 1 ? 'rgba(255,255,255,0.05)' : 'var(--accent)'}; cursor: ${page === totalPages - 1 ? 'not-allowed' : 'pointer'};" ${page === totalPages - 1 ? 'disabled' : ''} onclick="changeSubPage(${sub.id}, 1)">
                        Next ▶
                    </button>
                </div>
            </div>
        `;
    }
    
    return html;
}

window.changeSubPage = function(subId, delta) {
    const sub = submissionsCached.find(s => s.id === subId);
    if (!sub) return;
    
    const itemsPerPage = 10;
    const totalPages = Math.ceil(questionsList.length / itemsPerPage);
    let currentPage = submissionPages[subId] || 0;
    
    currentPage += delta;
    if (currentPage >= 0 && currentPage < totalPages) {
        submissionPages[subId] = currentPage;
        const container = document.getElementById(`details-container-${subId}`);
        if (container) {
            container.innerHTML = renderUserAnswers(sub);
        }
    }
};

// Helper formatting utilities
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatMarkdown(text) {
    const parts = text.split(/```python([\s\S]*?)```/g);
    let result = '';
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            result += `<pre><code class="python">${highlightPython(parts[i])}</code></pre>`;
        } else {
            result += escapeHtml(parts[i]).replace(/\n/g, '<br>');
        }
    }
    return result;
}

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

// Controller for new question additions from dashboard
window.submitNewQuestion = async function(e) {
    e.preventDefault();
    
    const topic = document.getElementById('q-add-topic').value.trim();
    const question = document.getElementById('q-add-text').value.trim();
    const optA = document.getElementById('q-opt-a').value.trim();
    const optB = document.getElementById('q-opt-b').value.trim();
    const optC = document.getElementById('q-opt-c').value.trim();
    const optD = document.getElementById('q-opt-d').value.trim();
    const correctIdx = document.getElementById('q-correct-select').value;
    
    if (!topic || !question || !optA || !optB || !optC || !optD || !correctIdx) {
        alert('Please fill out all fields.');
        return;
    }
    
    const payload = {
        topic: topic,
        question: question,
        options: [optA, optB, optC, optD],
        correct_idx: correctIdx
    };
    
    try {
        const res = await fetch('/api/admin/add-question', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + adminPasscode
            },
            body: JSON.stringify(payload)
        });
        
        if (res.status === 401) {
            handleUnauthorized();
            return;
        }
        
        const data = await res.json();
        if (res.ok) {
            alert('Success! Question has been safely saved to database.');
            document.getElementById('add-question-form').reset();
            
            // Refresh dashboard data instantly
            fetchData();
        } else {
            alert(data.error || 'Failed to save question.');
        }
    } catch (err) {
        console.error('Failed to submit question:', err);
        alert('Network error while saving question.');
    }
};
