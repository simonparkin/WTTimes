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
const articleTitleDisplay = document.getElementById("articleTitleDisplay");
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
const summaryContent = document.getElementById("summaryContent");

// ------------------------------
// HELPERS
// ------------------------------
function showScreen(screen) {
    settingsScreen.classList.add("hidden");
    discussionScreen.classList.add("hidden");
    summaryScreen.classList.add("hidden");
    screen.classList.remove("hidden");
}

// The article title is simply the first non-empty line of the pasted text.
// The article title is usually the first non-empty line of the pasted
// text. But if the user pastes the whole WOL page (header, nav menu, etc.
// included), the real title is repeated several times before the actual
// article starts — so instead we anchor on the opening theme song line
// (e.g. "SONG 122 Be Steadfast, Immovable!"), which always appears
// immediately before the real title.
function extractArticleTitle(text) {
    let lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    let songIndex = lines.findIndex(l => /^SONG\s+\d+/i.test(l));
    if (songIndex !== -1 && songIndex + 1 < lines.length) {
        return lines[songIndex + 1];
    }

    return lines.length > 0 ? lines[0] : "";
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
    return date.toTimeString().slice(0, 8);
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

        // Already-completed items: show what ACTUALLY happened, not the
        // last plan they had right before being completed (that plan is
        // stale the moment a unit is done, since live recalculation only
        // ever touches the current/upcoming units from here on).
        let hasActual = index < currentIndex && unit.actualSeconds !== null && unit.actualSeconds !== undefined;
        let time = hasActual ? unit.actualSeconds : unit.seconds;
        let timeText = hasActual
            ? `${formatDuration(time)} <span class="timeNote">actual</span>`
            : formatDuration(time);

        row.innerHTML = `
            <td>${label}</td>
            <td>${timeText}</td>
        `;
        timingsTableBody.appendChild(row);
    });
}

// Builds the end-of-discussion summary: for every item, shows the
// originally planned time (unit.plannedSeconds, captured once right after
// the discussion was generated) against the actual time it took
// (unit.actualSeconds, recorded each time Complete was pressed), plus how
// far ahead (+) or behind (-) that item ran. Also shows an overall total.
function renderSummaryTable() {
    let totalPlanned = 0;
    let totalActual = 0;

    let rows = units.map(unit => {
        let planned = unit.plannedSeconds || 0;
        let actual = unit.actualSeconds;
        let hasActual = actual !== null && actual !== undefined;

        totalPlanned += planned;
        if (hasActual) totalActual += actual;

        let diff = hasActual ? planned - actual : null; // positive = finished early, negative = ran over
        let diffText = diff === null
            ? "—"
            : (diff >= 0 ? `+${formatDuration(diff)}` : `−${formatDuration(-diff)}`);
        let diffClass = diff !== null && diff < 0 ? "negative" : "";

        let label = unit.fixed ? unit.label : `Paragraph ${unit.label}`;
        let rowClass = unit.fixed ? "fixedRow" : "";

        return `
            <tr class="${rowClass}">
                <td>${label}</td>
                <td>${formatDuration(planned)}</td>
                <td>${hasActual ? formatDuration(actual) : "—"}</td>
                <td class="${diffClass}">${diffText}</td>
            </tr>
        `;
    }).join("");

    let overallDiff = totalPlanned - totalActual;
    let overallText = overallDiff >= 0
        ? `Finished ${formatDuration(overallDiff)} ahead of schedule overall.`
        : `Finished ${formatDuration(-overallDiff)} behind schedule overall.`;

    summaryContent.innerHTML = `
        <table class="dataTable">
            <thead>
                <tr>
                    <th>Item</th>
                    <th>Planned</th>
                    <th>Actual</th>
                    <th>+/−</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="summaryOverall">${overallText}</p>
    `;
}

function updateDisplay() {
    let unit = units[currentIndex];
    currentParaLabel.textContent = unit.fixed
        ? unit.label.toUpperCase()
        : `PARAGRAPH ${unit.label}`;

    if (!hasStarted) {
        // Not started yet: blank placeholder, no red.
        currentTargetFinishTime = null;
        targetFinish.textContent = "--:--:--";
        targetFinish.classList.remove("overdue");
    } else if (remainingSeconds <= 0 || unit.seconds <= 0) {
        // No sensible target time left to show. This covers two cases:
        // - remainingSeconds <= 0: the whole meeting's overall time budget
        //   has been used up by earlier overruns, so even a fixed item
        //   (which always plans for exactly 60s) shouldn't show a calm
        //   "now + 1 minute" — there's genuinely no time left overall.
        // - unit.seconds <= 0: this specific paragraph's own word-based
        //   share has been squeezed to nothing by upcoming fixed costs.
        currentTargetFinishTime = null;
        targetFinish.textContent = "--:--:--";
        targetFinish.classList.add("overdue");
    } else {
        let now = new Date();
        let finish = new Date(now.getTime() + unit.seconds * 1000);
        currentTargetFinishTime = finish;
        targetFinish.textContent = formatTime(finish);
        targetFinish.classList.remove("overdue");
    }

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

// Two different rules depending on whether the discussion is currently
// ahead of or behind its original plan:
//
// AHEAD of schedule (banked-up surplus time): the surplus is shared
// proportionally across EVERYTHING still ahead — paragraphs and fixed
// items alike — continuously, the whole way through. This avoids all the
// saved time piling onto whichever paragraphs happen to be left (which
// would make, say, the very last paragraph balloon to an absurd planned
// time) only to suddenly "unlock" for the fixed items the moment
// paragraphs run out. Each unit's share of a surplus is proportional to
// its own originally-planned allocation (unit.plannedSeconds).
//
// BEHIND schedule (a deficit to make up): paragraphs absorb it first,
// shrinking down to a 30s floor each, before fixed items (Opening/Closing
// Comments, Review Questions) are touched at all. Only once paragraphs
// have hit that floor and there's still a deficit do fixed items start
// shrinking too, shared evenly among whatever's left.
function recalcVariableSeconds() {
    const PARAGRAPH_FLOOR_SECONDS = 30;

    let upcoming = units.slice(currentIndex);
    if (upcoming.length === 0) return;

    let fixedUpcoming = upcoming.filter(u => u.fixed);
    let paragraphsUpcoming = upcoming.filter(u => !u.fixed);

    let nominalRemainingTotal = upcoming.reduce((sum, u) => sum + (u.plannedSeconds || 0), 0);

    if (nominalRemainingTotal > 0 && remainingSeconds >= nominalRemainingTotal) {
        // On pace or ahead: share the surplus proportionally across
        // everything still ahead, fixed items included.
        let scale = remainingSeconds / nominalRemainingTotal;
        upcoming.forEach(u => { u.seconds = (u.plannedSeconds || 0) * scale; });
        return;
    }

    // Behind schedule (or no planned baseline yet) — paragraphs absorb the
    // deficit first, down to a floor, before fixed items are touched.
    if (paragraphsUpcoming.length === 0) {
        let share = fixedUpcoming.length > 0 ? remainingSeconds / fixedUpcoming.length : 0;
        fixedUpcoming.forEach(u => { u.seconds = share; });
        return;
    }

    let fixedFullTotal = fixedUpcoming.length * 60;
    let timeForParagraphsIfFixedFull = remainingSeconds - fixedFullTotal;
    let paragraphFloorTotal = paragraphsUpcoming.length * PARAGRAPH_FLOOR_SECONDS;
    let paragraphWords = paragraphsUpcoming.reduce((sum, u) => sum + u.words, 0);

    if (timeForParagraphsIfFixedFull >= paragraphFloorTotal) {
        // Affordable: fixed items keep their full planned 60s, paragraphs
        // split whatever's left by word count (never below the floor here,
        // since we already confirmed it's affordable).
        fixedUpcoming.forEach(u => { u.seconds = 60; });
        paragraphsUpcoming.forEach(u => {
            u.seconds = paragraphWords > 0
                ? (u.words / paragraphWords) * timeForParagraphsIfFixedFull
                : timeForParagraphsIfFixedFull / paragraphsUpcoming.length;
        });
    } else {
        // Not affordable: paragraphs are floored at 30s each, and the
        // fixed items absorb the remaining squeeze, shared evenly.
        paragraphsUpcoming.forEach(u => { u.seconds = PARAGRAPH_FLOOR_SECONDS; });
        let timeLeftForFixed = remainingSeconds - paragraphFloorTotal;
        let share = fixedUpcoming.length > 0 ? timeLeftForFixed / fixedUpcoming.length : 0;
        fixedUpcoming.forEach(u => { u.seconds = share; });
    }
}

// ------------------------------
// MAIN LOGIC
// ------------------------------
generateBtn.onclick = async () => {
    let text = document.getElementById("articleInput").value;
    let meetingLength = parseInt(document.getElementById("meetingLength").value);

    articleTitleDisplay.textContent = extractArticleTitle(text);

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

    // Capture the originally planned allocation for every unit, once, as
    // the baseline the end-of-discussion summary will compare actual time
    // against. Restarting the same discussion re-recalculates live
    // .seconds for display, but this baseline stays fixed.
    units.forEach(u => {
        u.plannedSeconds = u.seconds;
        u.actualSeconds = null;
    });

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
    let completedUnit = units[currentIndex];

    history.push({
        index: currentIndex,
        remaining: remainingSeconds,
        prevActualSeconds: completedUnit.actualSeconds
    });

    completedUnit.actualSeconds = elapsed;
    remainingSeconds -= elapsed;

    currentIndex++;
    if (currentIndex >= units.length) {
        renderSummaryTable();
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
    units[last.index].actualSeconds = last.prevActualSeconds;
    currentIndex = last.index;
    remainingSeconds = last.remaining;
    startTime = new Date();

    recalcVariableSeconds();
    updateDisplay();
};

restartBtn.onclick = () => {
    if (units.length === 0) {
        showScreen(settingsScreen);
        return;
    }

    currentIndex = 0;
    history = [];
    hasStarted = false;
    startTime = null;
    remainingSeconds = totalAllocated;

    units.forEach(u => { u.actualSeconds = null; });

    recalcVariableSeconds();

    completeBtn.textContent = "START";
    updateDisplay();
    showScreen(discussionScreen);
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