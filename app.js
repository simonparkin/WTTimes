// ------------------------------
// GLOBAL STATE
// ------------------------------
let units = [];              // grouped paragraph units
let currentIndex = 0;        // which unit we're on
let startTime = null;        // when the START button was pressed
let history = [];            // for undo
let totalAllocated = 0;      // total allocated seconds (from settings)
let remainingSeconds = 0;    // pre-start planning value; after START always derived from meetingEndTime
let meetingEndTime = null;   // fixed wall-clock end time, set once on START (or by user edit)
let meetingStartTime = null; // fixed wall-clock start time, set once on START, never overwritten
let hasStarted = false;      // whether the START button has been pressed yet
let currentTargetFinishTime = null; // Date the current item is supposed to finish by
let clockStyle = "clock";    // "clock" (wall-clock target time) or "countdown" (counts down)
let cameFromScreen = null;   // which screen "Back" on the settings screen should return to

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
const backFromSettingsBtn = document.getElementById("backFromSettingsBtn");
const clockStyleSelect = document.getElementById("clockStyleSelect");
const reviewQuestionLengthSelect = document.getElementById("reviewQuestionLength");
const reviewQuestionCustomRow = document.getElementById("reviewQuestionCustomRow");
const reviewQuestionCustomInput = document.getElementById("reviewQuestionCustom");
const backToSettingsBtn = document.getElementById("backToSettings");
const viewTimingsBtn = document.getElementById("viewTimingsBtn");
const closeTimingsBtn = document.getElementById("closeTimingsBtn");
const timingsModal = document.getElementById("timingsModal");
const timingsTableBody = document.getElementById("timingsTableBody");
const meetingEndTimeInput = document.getElementById("meetingEndTimeInput");
const summaryContent = document.getElementById("summaryContent");

// Show the custom seconds input only when "Other..." is selected; hide it
// and clear the value when switching back to a named option.
reviewQuestionLengthSelect.addEventListener("change", () => {
    let isOther = reviewQuestionLengthSelect.value === "other";
    reviewQuestionCustomInput.style.display = isOther ? "block" : "none";
    if (!isOther) reviewQuestionCustomInput.value = "";
});

// Enforce the 180-second maximum whenever the custom input is changed.
reviewQuestionCustomInput.addEventListener("change", () => {
    let val = parseInt(reviewQuestionCustomInput.value);
    if (isNaN(val) || val < 10) {
        reviewQuestionCustomInput.value = 10;
    } else if (val > 180) {
        reviewQuestionCustomInput.value = 180;
        alert("Maximum review question length is 3 minutes (180 seconds).");
    }
});


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
    text = text.replace(/^Your answers?\s*$/gim, "");

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
    let pendingOrphanWords = 0; // words from non-numbered blocks since the last group

    while (i < paragraphs.length) {
        let p = paragraphs[i];

        // Detect study question like "1-2." or "3."
        let match = p.match(/^(\d+)(?:-(\d+))?[\.\s]/);

        if (match) {
            // Flush any non-numbered blocks accumulated since the last group
            // (e.g. box content like "Bible Principles to Consider", photo
            // captions, collage descriptions) into that last group's word
            // count. These blocks sit between paragraphs in the article and
            // are read/discussed as part of the preceding paragraph, so they
            // deserve a proportional share of that paragraph's time.
            // Blocks before the very first numbered paragraph are ignored
            // (they're preamble: article title, focus statement, etc.).
            if (pendingOrphanWords > 0 && groups.length > 0) {
                groups[groups.length - 1].words += pendingOrphanWords;
                pendingOrphanWords = 0;
            }

            let start = parseInt(match[1]);
            let end = match[2] ? parseInt(match[2]) : start;
            let needed = end - start + 1;

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

            let combined = combinedBlocks.join(" ");
            let wordCount = combined.split(/\s+/).filter(Boolean).length;

            groups.push({
                label: match[2] ? `${start}-${end}` : `${start}`,
                text: combined,
                words: wordCount
            });

            i = j;
            lastConsumedEnd = j;
        } else {
            // Non-numbered block — count its words for the preceding group.
            // Blocks after the last numbered paragraph go into leftover anyway
            // so they won't be double-counted there.
            pendingOrphanWords += p.split(/\s+/).filter(Boolean).length;
            i++;
        }
    }

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
        // Use the live target the conductor was actually shown when this
        // item started — not the original generation-time plan, which
        // becomes misleading once overruns have recalculated everything.
        let target = unit.startPlannedSeconds !== null && unit.startPlannedSeconds !== undefined
            ? unit.startPlannedSeconds
            : unit.plannedSeconds || 0;
        let actual = unit.actualSeconds;
        let hasActual = actual !== null && actual !== undefined;

        totalPlanned += target;
        if (hasActual) totalActual += actual;

        let diff = hasActual ? target - actual : null;
        let diffText = diff === null
            ? "—"
            : (diff >= 0 ? `+${formatDuration(diff)}` : `−${formatDuration(-diff)}`);
        let diffClass = diff !== null && diff < 0 ? "negative" : "";

        let label = unit.fixed ? unit.label : `Paragraph ${unit.label}`;
        let rowClass = unit.fixed ? "fixedRow" : "";

        return `
            <tr class="${rowClass}">
                <td>${label}</td>
                <td>${formatDuration(target)}</td>
                <td>${hasActual ? formatDuration(actual) : "—"}</td>
                <td class="${diffClass}">${diffText}</td>
            </tr>
        `;
    }).join("");

    // Overall ahead/behind: compare total actual time spent against the
    // full meeting allocation (not the sum of original planned seconds,
    // which is also the allocation but can obscure recalculations).
    let totalAllocatedForSummary = meetingEndTime && meetingStartTime
        ? (meetingEndTime.getTime() - meetingStartTime.getTime()) / 1000
        : totalAllocated;
    let overallDiff = totalAllocatedForSummary - totalActual;
    let overallText = overallDiff >= 0
        ? `Finished ${formatDuration(overallDiff)} ahead of schedule overall.`
        : `Finished ${formatDuration(-overallDiff)} behind schedule overall.`;

    summaryContent.innerHTML = `
        <table class="dataTable">
            <thead>
                <tr>
                    <th>Item</th>
                    <th>Target</th>
                    <th>Actual</th>
                    <th>+/−</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="summaryOverall">${overallText}</p>
    `;
}

// Renders the big clock for whatever the current target finish time is,
// in whichever style is currently selected:
//   - "clock": the actual wall-clock time the current item should finish by
//     (doesn't need to change second-to-second, just needs the overdue
//     class toggled once the moment passes).
//   - "countdown": how much time is left until that same moment, ticking
//     down every second; once passed, counts up past zero as "-m:ss" to
//     show how far overdue.
// If there's no valid target (not started yet, or no time left at all),
// updateDisplay() already set the placeholder text directly and this is a
// no-op — there's nothing to tick.
function renderClock() {
    if (!currentTargetFinishTime) return;

    let now = new Date();
    let diffMs = currentTargetFinishTime.getTime() - now.getTime();
    let overdue = diffMs <= 0;

    if (clockStyle === "countdown") {
        let totalSeconds = Math.round(Math.abs(diffMs) / 1000);
        targetFinish.textContent = overdue
            ? `-${formatDuration(totalSeconds)}`
            : formatDuration(totalSeconds);
    } else {
        targetFinish.textContent = formatTime(currentTargetFinishTime);
    }

    targetFinish.classList.toggle("overdue", overdue);
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
        currentTargetFinishTime = new Date(Date.now() + unit.seconds * 1000);
        renderClock();
    }

    nextPara.textContent =
        currentIndex < units.length - 1
            ? units[currentIndex + 1].label
            : "-";
}

// Every second: re-render the clock (matters most for "countdown" mode,
// which needs to visibly tick down; "clock" mode just gets its overdue
// state re-checked, since the wall-clock text itself doesn't change).
setInterval(() => {
    if (discussionScreen.classList.contains("hidden")) return;
    renderClock();
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
// shrinking too, shared proportionally to each one's own baseline (so
// Opening/Closing Comments, at 90s, give up more than a Review Question
// at 60s, rather than everyone losing an identical flat amount).
function recalcVariableSeconds() {
    // If the meeting has started, always derive remaining time from the
    // fixed meetingEndTime anchor rather than a manually-decremented
    // counter — this means undo, pausing, or any other operation can
    // never accidentally push the meeting end time around.
    if (meetingEndTime) {
        remainingSeconds = Math.max(0, (meetingEndTime.getTime() - Date.now()) / 1000);
    }

    const PARAGRAPH_FLOOR_SECONDS = 60;

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
    let fixedWeightTotal = fixedUpcoming.reduce((sum, u) => sum + u.fixedSeconds, 0);

    if (paragraphsUpcoming.length === 0) {
        fixedUpcoming.forEach(u => {
            u.seconds = fixedWeightTotal > 0
                ? (u.fixedSeconds / fixedWeightTotal) * remainingSeconds
                : remainingSeconds / fixedUpcoming.length;
        });
        return;
    }

    let fixedFullTotal = fixedWeightTotal;
    let timeForParagraphsIfFixedFull = remainingSeconds - fixedFullTotal;
    let paragraphFloorTotal = paragraphsUpcoming.length * PARAGRAPH_FLOOR_SECONDS;
    let paragraphWords = paragraphsUpcoming.reduce((sum, u) => sum + u.words, 0);

    if (timeForParagraphsIfFixedFull >= paragraphFloorTotal) {
        // Affordable: fixed items keep their own full planned baseline,
        // paragraphs split whatever's left by word count (never below the
        // floor here, since we already confirmed it's affordable).
        fixedUpcoming.forEach(u => { u.seconds = u.fixedSeconds; });
        paragraphsUpcoming.forEach(u => {
            u.seconds = paragraphWords > 0
                ? (u.words / paragraphWords) * timeForParagraphsIfFixedFull
                : timeForParagraphsIfFixedFull / paragraphsUpcoming.length;
        });
    } else {
        // Not affordable: paragraphs are floored at 30s each, and the
        // fixed items absorb the remaining squeeze, shared proportionally
        // to their own baseline.
        paragraphsUpcoming.forEach(u => { u.seconds = PARAGRAPH_FLOOR_SECONDS; });
        let timeLeftForFixed = remainingSeconds - paragraphFloorTotal;
        fixedUpcoming.forEach(u => {
            u.seconds = fixedWeightTotal > 0
                ? (u.fixedSeconds / fixedWeightTotal) * timeLeftForFixed
                : timeLeftForFixed / fixedUpcoming.length;
        });
    }
}

// ------------------------------
// MAIN LOGIC
// ------------------------------
generateBtn.onclick = async () => {
    let text = document.getElementById("articleInput").value;
    let meetingLength = parseInt(document.getElementById("meetingLength").value);
    let reviewQuestionSeconds = reviewQuestionLengthSelect.value === "other"
        ? Math.min(180, Math.max(10, parseInt(reviewQuestionCustomInput.value) || 60))
        : parseInt(reviewQuestionLengthSelect.value);
    clockStyle = clockStyleSelect.value;

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

    let openingUnit = { label: "Opening Comments", words: 0, fixed: true, fixedSeconds: 90, seconds: 90 };
    let closingUnit = { label: "Closing Comments", words: 0, fixed: true, fixedSeconds: 90, seconds: 90 };
    let reviewUnits = [];
    for (let n = 1; n <= reviewCount; n++) {
        reviewUnits.push({ label: `Review Question ${n}`, words: 0, fixed: true, fixedSeconds: reviewQuestionSeconds, seconds: reviewQuestionSeconds });
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
        meetingStartTime = now;
        meetingEndTime = new Date(now.getTime() + remainingSeconds * 1000);
        completeBtn.textContent = "COMPLETE";
        // Capture the live planned time for the first item (Opening Comments)
        // at the moment it actually starts — this is what the conductor sees.
        units[currentIndex].startPlannedSeconds = units[currentIndex].seconds;
        updateDisplay();
        return;
    }

    let elapsed = (now - startTime) / 1000;
    let completedUnit = units[currentIndex];

    history.push({
        index: currentIndex,
        savedTargetFinishTime: currentTargetFinishTime,
        prevActualSeconds: completedUnit.actualSeconds,
        prevStartPlannedSeconds: units[currentIndex + 1] ? units[currentIndex + 1].startPlannedSeconds : null
    });

    completedUnit.actualSeconds = elapsed;

    currentIndex++;
    if (currentIndex >= units.length) {
        renderSummaryTable();
        showScreen(summaryScreen);
        return;
    }

    recalcVariableSeconds();

    // Capture the live planned time for the next item at the moment it
    // becomes current — after recalc, this is the honest "target" the
    // conductor is now working against, which may differ from the
    // original generation-time plan if earlier items ran over or under.
    units[currentIndex].startPlannedSeconds = units[currentIndex].seconds;

    startTime = now;
    updateDisplay();
};

undoBtn.onclick = () => {
    if (history.length === 0) return;

    let last = history.pop();
    units[last.index].actualSeconds = last.prevActualSeconds;
    // Restore the next unit's startPlannedSeconds too — if undo is pressed
    // immediately after Complete, the new current unit may have had its
    // startPlannedSeconds set from an aborted recalc.
    if (units[last.index + 1]) {
        units[last.index + 1].startPlannedSeconds = last.prevStartPlannedSeconds;
    }
    currentIndex = last.index;

    // Restore the exact clock display that was showing before Complete was
    // pressed — even if it's already in the past and showing red. Do NOT
    // reset startTime (that would invent a new future deadline) and do NOT
    // touch remainingSeconds (recalcVariableSeconds derives it from the
    // fixed meetingEndTime, so the overall meeting end time is unaffected).
    currentTargetFinishTime = last.savedTargetFinishTime;

    recalcVariableSeconds();

    // Update the label and next-para display without recomputing the clock.
    let unit = units[currentIndex];
    currentParaLabel.textContent = unit.fixed
        ? unit.label.toUpperCase()
        : `PARAGRAPH ${unit.label}`;
    nextPara.textContent = currentIndex < units.length - 1
        ? units[currentIndex + 1].label
        : "-";
    renderClock();
};

restartBtn.onclick = () => {
    if (units.length === 0) {
        showScreen(settingsScreen);
        return;
    }

    if (!confirm("Are you sure you want to restart? This will reset all progress for this discussion.")) {
        return;
    }

    currentIndex = 0;
    history = [];
    hasStarted = false;
    startTime = null;
    meetingEndTime = null;
    meetingStartTime = null;
    remainingSeconds = totalAllocated;

    units.forEach(u => { u.actualSeconds = null; });

    recalcVariableSeconds();

    completeBtn.textContent = "START";
    updateDisplay();
    showScreen(discussionScreen);
};

// Going into Settings from somewhere mid-session shouldn't be a dead end —
// remember where we came from so the Back button can return there.
function enterSettingsScreen(fromScreen) {
    cameFromScreen = fromScreen;
    backFromSettingsBtn.classList.remove("hidden");
    showScreen(settingsScreen);
}

settingsBtn.onclick = () => {
    enterSettingsScreen(discussionScreen);
};

backToSettingsBtn.onclick = () => {
    enterSettingsScreen(summaryScreen);
};

backFromSettingsBtn.onclick = () => {
    if (!cameFromScreen) return;
    showScreen(cameFromScreen);
    // Nothing in the underlying state changed just by visiting Settings,
    // so just re-render the clock as it already was rather than
    // recomputing a new target finish time (which would unfairly push
    // the current item's deadline forward by however long was spent
    // browsing Settings).
    renderClock();
};

viewTimingsBtn.onclick = () => {
    renderTimingsTable();
    meetingEndTimeInput.value = getProjectedEndTimeString();
    timingsModal.classList.remove("hidden");
};

closeTimingsBtn.onclick = () => {
    timingsModal.classList.add("hidden");
};

// Returns the projected meeting end time as a "HH:MM" string suitable for
// a <input type="time">. If the discussion has started, this is the moment
// when remainingSeconds run out from now. If not yet started, it's
// totalAllocated seconds from now, as a best-guess preview.
function getProjectedEndTimeString() {
    let endMs = meetingEndTime
        ? meetingEndTime.getTime()
        : Date.now() + remainingSeconds * 1000;
    let d = new Date(endMs);
    let hh = d.getHours().toString().padStart(2, "0");
    let mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
}

// When the conductor edits the end time, update meetingEndTime — the only
// place besides START that is allowed to move the meeting's end anchor.
meetingEndTimeInput.addEventListener("change", () => {
    let val = meetingEndTimeInput.value;
    if (!val) return;

    let [hh, mm] = val.split(":").map(Number);
    let now = new Date();
    let newEnd = new Date(now);
    newEnd.setHours(hh, mm, 0, 0);
    if (newEnd <= now) newEnd.setDate(newEnd.getDate() + 1);

    let newRemaining = (newEnd.getTime() - now.getTime()) / 1000;
    if (newRemaining <= 0) return;

    meetingEndTime = newEnd;
    remainingSeconds = newRemaining;
    recalcVariableSeconds();
    renderTimingsTable();

    if (hasStarted && currentIndex < units.length) {
        currentTargetFinishTime = new Date(Date.now() + units[currentIndex].seconds * 1000);
        renderClock();
    }
});
