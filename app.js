// ------------------------------
// GLOBAL STATE
// ------------------------------
let units = [];              // grouped paragraph units
let currentIndex = 0;        // which unit we're on
let startTime = null;        // when discussion started
let history = [];            // for undo
let totalAllocated = 0;      // total allocated seconds
let remainingSeconds = 0;    // remaining time
let hasStarted = false;      // whether the START button has been pressed yet
let currentTargetFinishTime = null; // Date the current item is supposed to finish by

// ------------------------------
// SCREEN ELEMENTS
// ------------------------------
const settingsScreen = document.getElementById("settingsScreen");
const discussionScreen = document.getElementById("discussionScreen");
const summaryScreen = document.getElementById("summaryScreen");

const currentParaLabel = document.getElementById("currentParaLabel");
const targetFinish = document.getElementById("targetFinish");
const nextPara = document.getElementById("nextPara");

const generateBtn = document.getElementById("generateBtn");
const completeBtn = document.getElementById("completeBtn");
const undoBtn = document.getElementById("undoBtn");
const restartBtn = document.getElementById("restartBtn");
const settingsBtn = document.getElementById("settingsBtn");
const backToSettingsBtn = document.getElementById("backToSettings");
const viewTimingsBtn = document.getElementById("viewTimingsBtn");
const closeTimingsBtn = document.getElementById("closeTimingsBtn");
const timingsModal = document.getElementById("timingsModal");
const timingsTableBody = document.getElementById("timingsTableBody");

// ------------------------------
// HELPERS
// ------------------------------
function showScreen(screen) {
    settingsScreen.classList.add("hidden");
    discussionScreen.classList.add("hidden");
    summaryScreen.classList.add("hidden");
    screen.classList.remove("hidden");
}

function parseParagraphs(text) {
    text = text.replace(/\r/g, "");

    // Force a blank line before any numbered line (e.g. "3." or "1-2.").
    // This separates section headings and "Your answer" lines that are
    // glued directly onto the next line with no blank line between them,
    // so every question/paragraph reliably becomes its own block.
    text = text.replace(/\n(?=\d+(?:-\d+)?[\.\s])/g, "\n\n");

    // Remove "Your answer" placeholder lines entirely (now isolated on
    // their own line thanks to the step above).
    text = text.replace(/^Your answer\s*$/gim, "");

    return text
        .split(/\n\s*\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0)
        // Remove ALL CAPS subheadings (but keep numbered paragraphs)
        .filter(p => {
            if (/^[A-Z0-9 ,.'’\-:()?!]+$/.test(p)) {
                if (/^\d/.test(p)) return true; // keep paragraphs like "3 Adversities..."
                return false; // remove subheading
            }
            return true;
        });
}


function detectGroups(paragraphs) {
    let groups = [];
    let i = 0;
    let lastConsumedEnd = 0; // index right after the last group's consumed blocks

    while (i < paragraphs.length) {
        let p = paragraphs[i];

        // Detect study question like "1-2." or "3."
        let match = p.match(/^(\d+)(?:-(\d+))?[\.\s]/);

        if (match) {
            let start = parseInt(match[1]);
            let end = match[2] ? parseInt(match[2]) : start;
            let needed = end - start + 1; // how many answer paragraphs to expect

            // Simply take the next `needed` blocks as the answer paragraphs.
            // This naturally handles paragraph 1, which is never numbered
            // (it's just plain text), since it's still the very next block
            // after its question.
            let combinedBlocks = [p];
            let consumed = 0;
            let j = i + 1;
            while (consumed < needed && j < paragraphs.length) {
                combinedBlocks.push(paragraphs[j]);
                consumed++;
                j++;
            }

            if (consumed < needed) {
                console.warn(
                    `Expected ${needed} paragraph(s) for "${match[0].trim()}" but only found ${consumed}.`
                );
            }

            // Merge everything into one discussion unit
            let combined = combinedBlocks.join(" ");
            let wordCount = combined.split(/\s+/).filter(Boolean).length;

            groups.push({
                label: match[2] ? `${start}-${end}` : `${start}`,
                text: combined,
                words: wordCount
            });

            i = j; // move past the question AND all the blocks we consumed
            lastConsumedEnd = j;
        } else {
            i++;
        }
    }

    // Anything after the last paragraph group (e.g. review questions at
    // the end of the article) is returned separately so the caller can
    // decide what to do with it.
    return { groups, leftover: paragraphs.slice(lastConsumedEnd) };
}

// Counts review questions structurally: any leftover text blocks after the
// last numbered paragraph, stopping at the closing "SONG ..." line or a
// footnote line (e.g. "a For instance..."). This works regardless of how
// the heading above the review questions is worded (or whether one exists).
function countReviewQuestions(leftover) {
    let count = 0;
    for (let p of leftover) {
        if (/^SONG\b/i.test(p)) break;
        if (/^[a-z]\s/.test(p)) break; // footnote line
        count++;
    }
    return count;
}

// Finds "Read <Book> <chapter>:<verses>" citations within a paragraph's
// text. These are scriptures that get read aloud during the discussion,
// so their actual word count should count toward that paragraph's time.
// Detection is anchored purely on the literal word "Read" immediately
// preceding the citation — NOT on whether the book name looks "full" vs
// "abbreviated." That distinction isn't reliable anyway, since several
// books (Luke, Mark, Ruth, Job, Amos, etc.) have no separate short form
// at all, so their abbreviated and full names are identical.
function parseReadCitations(text) {
    let regex = /Read\s+((?:[1-3]\s)?[A-Za-z]+)\s+(\d+):([\d,\-\s]+)/gi;
    let matches = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        matches.push({ book: m[1].trim(), chapter: m[2], verseList: m[3].trim() });
    }
    return matches;
}

// "7, 11" -> ["7", "11"]   "7-11" stays as a single range token "7-11"
function expandVerseTokens(verseListStr) {
    return verseListStr.split(",").map(s => s.trim()).filter(Boolean);
}

// Fetches the actual text of a single verse or verse range from a free,
// keyless Bible API, and returns its word count. Returns 0 on any failure
// (no internet, verse not found, etc.) so a lookup problem never crashes
// the app — it just slightly under-counts that paragraph's words.
async function fetchVerseWordCount(book, chapter, token) {
    let ref = `${book.replace(/\s+/g, "+")}+${chapter}:${token}`;
    let url = `https://bible-api.com/${ref}?translation=web`;
    try {
        let res = await fetch(url);
        let data = await res.json();
        if (data && data.text) {
            return data.text.trim().split(/\s+/).filter(Boolean).length;
        }
    } catch (e) {
        console.warn("Could not fetch verse text for " + ref, e);
    }
    return 0;
}

// Scans a unit's text for "Read ___" citations and adds the real word
// count of each cited verse/range onto unit.words.
async function addReadScriptureWords(unit) {
    let citations = parseReadCitations(unit.text);
    for (let citation of citations) {
        let tokens = expandVerseTokens(citation.verseList);
        for (let token of tokens) {
            let words = await fetchVerseWordCount(citation.book, citation.chapter, token);
            unit.words += words;
        }
    }
}


function formatTime(date) {
    return date.toTimeString().slice(0, 5);
}

// Formats a number of seconds as "m:ss"
function formatDuration(seconds) {
    let total = Math.round(seconds);
    let m = Math.floor(total / 60);
    let s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderTimingsTable() {
    timingsTableBody.innerHTML = "";

    units.forEach((unit, index) => {
        let row = document.createElement("tr");
        if (index === currentIndex) row.classList.add("currentRow");
        if (unit.fixed) row.classList.add("fixedRow");

        let label = unit.fixed ? unit.label : `Paragraph ${unit.label}`;

        row.innerHTML = `
            <td>${label}</td>
            <td>${formatDuration(unit.seconds)}</td>
        `;
        timingsTableBody.appendChild(row);
    });
}

function updateDisplay() {
    let unit = units[currentIndex];
    currentParaLabel.textContent = unit.fixed
        ? unit.label.toUpperCase()
        : `PARAGRAPH ${unit.label}`;

    if (hasStarted) {
        let now = new Date();
        let finish = new Date(now.getTime() + unit.seconds * 1000);
        currentTargetFinishTime = finish;
        targetFinish.textContent = formatTime(finish);
    } else {
        currentTargetFinishTime = null;
        targetFinish.textContent = "--:--";
    }
    targetFinish.classList.remove("overdue");

    nextPara.textContent =
        currentIndex < units.length - 1
            ? units[currentIndex + 1].label
            : "-";
}

// Every second, check whether we've gone past the current target finish
// time, and turn the display red if so.
setInterval(() => {
    if (!currentTargetFinishTime || discussionScreen.classList.contains("hidden")) return;
    if (new Date() > currentTargetFinishTime) {
        targetFinish.classList.add("overdue");
    } else {
        targetFinish.classList.remove("overdue");
    }
}, 1000);

// Redistributes remainingSeconds across the still-to-come PARAGRAPH units only.
// Fixed units (Opening/Closing Comments, Review Questions) always keep their
// fixed allocation (e.g. 60 seconds) and are excluded from this math.
function recalcVariableSeconds() {
    let upcoming = units.slice(currentIndex);

    let fixedSecondsUpcoming = upcoming
        .filter(u => u.fixed)
        .reduce((sum, u) => sum + u.seconds, 0);

    let variableUpcoming = upcoming.filter(u => !u.fixed);
    let variableTimeRemaining = remainingSeconds - fixedSecondsUpcoming;
    let variableWords = variableUpcoming.reduce((sum, u) => sum + u.words, 0);

    variableUpcoming.forEach(u => {
        u.seconds = variableWords > 0
            ? (u.words / variableWords) * variableTimeRemaining
            : 0;
    });
}

// ------------------------------
// MAIN LOGIC
// ------------------------------
generateBtn.onclick = async () => {
    let text = document.getElementById("articleInput").value;
    let meetingLength = parseInt(document.getElementById("meetingLength").value);

    generateBtn.disabled = true;
    generateBtn.textContent = "Looking up cited scriptures...";

    let paragraphs = parseParagraphs(text);
    let { groups: paragraphGroups, leftover } = detectGroups(paragraphs);
    paragraphGroups = paragraphGroups.map(u => ({ ...u, fixed: false }));

    // Add the real word count of any "Read ___" scriptures onto the
    // paragraph that cites them, so reading time is accounted for.
    for (let unit of paragraphGroups) {
        await addReadScriptureWords(unit);
    }

    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Discussion";

    let reviewCount = countReviewQuestions(leftover);

    let openingUnit = { label: "Opening Comments", words: 0, fixed: true, seconds: 60 };
    let closingUnit = { label: "Closing Comments", words: 0, fixed: true, seconds: 60 };
    let reviewUnits = [];
    for (let n = 1; n <= reviewCount; n++) {
        reviewUnits.push({ label: `Review Question ${n}`, words: 0, fixed: true, seconds: 60 });
    }

    units = [openingUnit, ...paragraphGroups, ...reviewUnits, closingUnit];

    totalAllocated = meetingLength * 60;
    remainingSeconds = totalAllocated;

    currentIndex = 0;
    history = [];
    hasStarted = false;
    startTime = null;

    recalcVariableSeconds();

    completeBtn.textContent = "START";
    updateDisplay();
    showScreen(discussionScreen);
};

completeBtn.onclick = () => {
    // Flash effect
    completeBtn.classList.add("flash");
    setTimeout(() => completeBtn.classList.remove("flash"), 200);

    let now = new Date();

    // First press just starts the clock on Opening Comments;
    // it doesn't complete anything.
    if (!hasStarted) {
        hasStarted = true;
        startTime = now;
        completeBtn.textContent = "COMPLETE";
        updateDisplay();
        return;
    }

    let elapsed = (now - startTime) / 1000;

    history.push({
        index: currentIndex,
        remaining: remainingSeconds
    });

    remainingSeconds -= elapsed;

    currentIndex++;
    if (currentIndex >= units.length) {
        showScreen(summaryScreen);
        return;
    }

    recalcVariableSeconds();

    startTime = now;
    updateDisplay();
};

undoBtn.onclick = () => {
    if (history.length === 0) return;

    let last = history.pop();
    currentIndex = last.index;
    remainingSeconds = last.remaining;
    startTime = new Date();

    recalcVariableSeconds();
    updateDisplay();
};

restartBtn.onclick = () => {
    showScreen(settingsScreen);
};

settingsBtn.onclick = () => {
    showScreen(settingsScreen);
};

backToSettingsBtn.onclick = () => {
    showScreen(settingsScreen);
};

viewTimingsBtn.onclick = () => {
    renderTimingsTable();
    timingsModal.classList.remove("hidden");
};

closeTimingsBtn.onclick = () => {
    timingsModal.classList.add("hidden");
};
