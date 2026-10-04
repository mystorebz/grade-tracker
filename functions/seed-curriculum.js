#!/usr/bin/env node
'use strict';
/**
 * functions/seed-curriculum.js — 4th-grade curriculum + grades for QA-SCHOOL-01 (LIVE dev project)
 *
 *   node seed-curriculum.js
 *
 * Run AFTER seed-test-accounts.js. Idempotent: fixed doc IDs, re-runs overwrite
 * (scores re-randomize). Refuses to overwrite any doc not tagged _qaSeed.
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 *
 * Writes (same shapes the app writes):
 *   schools/QA-SCHOOL-01/semesters/QA-SEM-01            only if the school has no activeSemesterId
 *   schools/QA-SCHOOL-01/classes/QA-CLASS-01/subjects/{QA-SUBJ-MATH4, QA-SUBJ-ELA4}
 *     …/QA-SUBJ-MATH4/assignments/qa-asg-mult-w1
 *     …/QA-SUBJ-MATH4/assignments/qa-asg-mult-w1/submissions/{studentId}   status 'graded'
 *     …/{subject}/lessons/{qa-lsn-*}                                       authored by T99-QA001
 *   students/{studentId}/grades/qa-grd-mult-w1                             gradebook record
 *   + one graded assignment per remaining subject (new-model and the teacher's
 *     legacy ds1–ds8 subjects), so every student has a grade in every subject
 */

const PROJECT_ID = 'dev-school-grade-tracker';
const requested = process.env.QA_PROJECT_ID || PROJECT_ID;
if (requested !== PROJECT_ID) {
    console.error(`[FAIL] Refusing to run against "${requested}". Only ${PROJECT_ID} is allowed.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'qa-curriculum');
const db = getFirestore(app);

// ── FIXTURE ─────────────────────────────────────────────────────────────────
const SCHOOL = 'QA-SCHOOL-01';
const CLASS_ID = 'QA-CLASS-01';
const CLASS_NAME = 'QA Class 1';
const AUTHOR = { authorId: 'T99-QA001', authorName: 'QA Teacher' };
const TAG = Object.freeze({ _qaSeed: true, _seededBy: 'functions/seed-curriculum.js' });

const SUBJECTS = {
    math: { id: 'QA-SUBJ-MATH4', name: '4th Grade Math', description: 'Grade 4 mathematics: multiplication, multi-digit addition, place value.' },
    ela: { id: 'QA-SUBJ-ELA4', name: '4th Grade Language Arts', description: 'Grade 4 language arts: grammar, punctuation, reading and writing.' },
};

const ASSIGNMENT = {
    id: 'qa-asg-mult-w1',
    gradeDocId: 'qa-grd-mult-w1',
    title: 'Multiplication Mastery - Week 1',
    description: 'Complete the 20 multiplication word problems attached. Show all work for carrying numbers.',
    type: 'Assignment',
    maxScore: 100,
};

const html = (objectives, sections) =>
    `<h2>Learning Objectives</h2><ul>${objectives.map((o) => `<li>${o}</li>`).join('')}</ul>` +
    sections.map(([h, body]) => `<h2>${h}</h2>${body}`).join('');

const LESSONS = [
    {
        id: 'qa-lsn-ela-nouns', subject: 'ela',
        title: 'Mastering Nouns and Parts of Speech',
        contentHtml: html(
            [
                'Define a noun as a word that names a person, place, thing, or idea.',
                'Tell the difference between proper, common, and abstract nouns.',
                'Identify every noun in a sentence.',
            ],
            [
                ['Common Nouns', '<p>A <strong>common noun</strong> names any person, place, or thing. It is not capitalized unless it starts a sentence.</p><ul><li>teacher, city, dog, river</li></ul>'],
                ['Proper Nouns', '<p>A <strong>proper noun</strong> names a specific person, place, or thing. It always begins with a capital letter.</p><ul><li>Ms. Lopez, Belize City, Rover, Belize River</li></ul>'],
                ['Abstract Nouns', '<p>An <strong>abstract noun</strong> names an idea, feeling, or quality you cannot see or touch.</p><ul><li>courage, friendship, honesty, joy</li></ul>'],
                ['Practice: Find the Nouns', '<p>Underline every noun. Label it C (common), P (proper), or A (abstract).</p><ol><li>Maria showed great kindness to the new student.</li><li>Our class visited the zoo in Belmopan on Friday.</li><li>The puppy chased the ball across the yard with excitement.</li></ol>'],
                ['Exit Ticket', '<p>Write one sentence that uses a proper noun, a common noun, and an abstract noun. Circle each one.</p>'],
            ],
        ),
    },
    {
        id: 'qa-lsn-ela-punctuation', subject: 'ela',
        title: 'Punctuation Rules: Commas and Quotes',
        contentHtml: html(
            [
                'Use commas to separate three or more items in a series.',
                'Use quotation marks around the exact words a speaker says.',
                'Place commas and end marks correctly inside quotation marks.',
            ],
            [
                ['Commas in a Series', '<p>When you list three or more items, put a comma after each item except the last. Use <em>and</em> or <em>or</em> before the last item.</p><ul><li>We packed apples, oranges, and bananas.</li><li>You can choose red, blue, or green.</li></ul>'],
                ['Quotation Marks for Dialogue', '<p>Quotation marks go around the exact words someone says. Start the quote with a capital letter.</p><ul><li>"Please open your books," said Mr. Young.</li><li>Ana asked, "May I read the next page?"</li></ul>'],
                ['Where the Punctuation Goes', '<p>Commas, periods, question marks, and exclamation points that belong to the quote go <strong>inside</strong> the closing quotation mark.</p>'],
                ['Practice: Fix the Sentences', '<ol><li>I need pencils erasers and glue for the project.</li><li>Where are we going asked Leo.</li><li>Mom said dinner is ready.</li></ol>'],
                ['Exit Ticket', '<p>Write a two-line conversation between two friends that also includes a list of three things. Use commas and quotation marks correctly.</p>'],
            ],
        ),
    },
    {
        id: 'qa-lsn-math-arrays', subject: 'math',
        title: 'Introduction to Multiplication Arrays',
        contentHtml: html(
            [
                'Represent a multiplication fact as an array of equal rows and columns.',
                'Write the multiplication sentence that matches an array.',
                'Use the commutative property to turn an array (3 × 5 = 5 × 3).',
            ],
            [
                ['What Is an Array?', '<p>An <strong>array</strong> is a set of objects arranged in equal rows and equal columns. Rows go across; columns go down.</p>'],
                ['Reading an Array', '<p>An array with 4 rows of 6 dots shows <strong>4 × 6 = 24</strong>. Count the rows, count the dots in one row, then multiply.</p><pre>● ● ● ● ● ●\n● ● ● ● ● ●\n● ● ● ● ● ●\n● ● ● ● ● ●</pre>'],
                ['Turning the Array', '<p>Rotate the grid: 6 rows of 4 dots is still 24. The order of factors does not change the product.</p>'],
                ['Practice: Draw and Solve', '<p>On grid paper, draw an array for each fact and write the product.</p><ol><li>3 × 7</li><li>5 × 8</li><li>6 × 6</li><li>9 × 4</li></ol>'],
                ['Exit Ticket', '<p>A garden has 7 rows with 8 plants in each row. Draw the array and write the multiplication sentence.</p>'],
            ],
        ),
    },
    {
        id: 'qa-lsn-math-addition', subject: 'math',
        title: 'Advanced Addition & Carrying',
        contentHtml: html(
            [
                'Add multi-digit numbers by lining up place values.',
                'Regroup (carry) from the ones, tens, hundreds, and thousands columns.',
                'Check a sum using estimation.',
            ],
            [
                ['Line Up the Place Values', '<p>Write the numbers in columns: thousands, hundreds, tens, ones. Always start adding in the ones column.</p>'],
                ['Regrouping Over the Hundreds', '<p>Example: 2,764 + 1,589</p><ul><li>Ones: 4 + 9 = 13 → write 3, carry 1 ten.</li><li>Tens: 6 + 8 + 1 = 15 → write 5, carry 1 hundred.</li><li>Hundreds: 7 + 5 + 1 = 13 → write 3, carry 1 thousand.</li><li>Thousands: 2 + 1 + 1 = 4.</li></ul><p><strong>Sum: 4,353</strong></p>'],
                ['Regrouping Into a New Column', '<p>Example: 6,875 + 4,968 = 11,843. When the thousands column reaches 10 or more, the carried 1 becomes a new ten-thousands digit.</p>'],
                ['Check by Estimating', '<p>Round each addend to the nearest thousand: 7,000 + 5,000 = 12,000, so 11,843 is reasonable.</p>'],
                ['Practice', '<ol><li>3,486 + 2,795</li><li>5,609 + 3,847</li><li>7,958 + 4,376</li><li>8,099 + 1,906</li></ol>'],
            ],
        ),
    },
];

// ── HELPERS ─────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const rid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const schoolRef = db.collection('schools').doc(SCHOOL);
const classRef = schoolRef.collection('classes').doc(CLASS_ID);
const subjectRef = (key) => classRef.collection('subjects').doc(SUBJECTS[key].id);

// Fails closed: an existing doc at a seed path must carry the _qaSeed tag.
async function assertWritable(refs) {
    const snaps = await db.getAll(...refs);
    const foreign = snaps.filter((s) => s.exists && s.get('_qaSeed') !== true).map((s) => s.ref.path);
    if (foreign.length) throw new Error(`Refusing to overwrite untagged docs:\n  ${foreign.join('\n  ')}`);
}

async function resolveSemester() {
    const school = await schoolRef.get();
    if (!school.exists) throw new Error(`${SCHOOL} not found. Run: node seed-test-accounts.js`);
    const active = school.get('activeSemesterId');
    if (active) return active;

    const semId = 'QA-SEM-01';
    await assertWritable([schoolRef.collection('semesters').doc(semId)]);
    await schoolRef.collection('semesters').doc(semId).set({ ...TAG, name: 'Term 1', order: 1, isLocked: false, createdAt: nowIso() });
    await schoolRef.set({ activeSemesterId: semId }, { merge: true });
    console.log(`[OK]   semester ${semId} created and set active`);
    return semId;
}

async function loadStudents() {
    const snap = await db.collection('students')
        .where('currentSchoolId', '==', SCHOOL)
        .where('enrollmentStatus', '==', 'Active')
        .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`[INFO] project=${PROJECT_ID} school=${SCHOOL} class=${CLASS_ID}`);

    const klass = await classRef.get();
    if (!klass.exists) throw new Error(`${classRef.path} not found. Run: node seed-test-accounts.js`);

    const semesterId = await resolveSemester();
    const students = await loadStudents();
    if (!students.length) throw new Error(`No active students in ${SCHOOL}.`);

    const asgRef = subjectRef('math').collection('assignments').doc(ASSIGNMENT.id);
    const lessonRefs = LESSONS.map((l) => subjectRef(l.subject).collection('lessons').doc(l.id));
    const subRefs = students.map((s) => asgRef.collection('submissions').doc(s.id));
    const gradeRefs = students.map((s) => db.collection('students').doc(s.id).collection('grades').doc(ASSIGNMENT.gradeDocId));

    await assertWritable([subjectRef('math'), subjectRef('ela'), asgRef, ...lessonRefs, ...subRefs, ...gradeRefs]);

    const batch = db.batch();
    const ts = nowIso();
    const date = today();

    // 1. Subjects (new per-class model, same shape as teacher/subjects saveSubject())
    for (const key of Object.keys(SUBJECTS)) {
        const s = SUBJECTS[key];
        batch.set(subjectRef(key), {
            ...TAG, name: s.name, description: s.description,
            schoolId: SCHOOL, classId: CLASS_ID, archived: false, archivedAt: null, createdAt: ts,
        });
    }

    // 2. Assignment (same shape as grade_form ensureAssignmentDoc())
    batch.set(asgRef, {
        ...TAG, id: ASSIGNMENT.id, title: ASSIGNMENT.title, type: ASSIGNMENT.type,
        maxScore: ASSIGNMENT.maxScore, description: ASSIGNMENT.description, instructions: ASSIGNMENT.description,
        date, completed: true, createdAt: ts,
    });

    // 3. Per-student graded submission + gradebook record
    const results = [];
    students.forEach((st, i) => {
        const score = randInt(75, 100);
        results.push([st.id, st.name, score]);

        batch.set(subRefs[i], {
            ...TAG,
            studentId: st.id, studentName: st.name || '',
            assignmentId: ASSIGNMENT.id, assignmentTitle: ASSIGNMENT.title, workType: ASSIGNMENT.type,
            subjectId: SUBJECTS.math.id, subjectName: SUBJECTS.math.name,
            classId: CLASS_ID, className: CLASS_NAME,
            responseText: 'Completed all 20 word problems with work shown.', linkUrl: null,
            status: 'graded', submittedAt: ts, updatedAt: ts,
        });

        batch.set(gradeRefs[i], {
            ...TAG,
            schoolId: SCHOOL, teacherId: AUTHOR.authorId, semesterId,
            className: st.className || CLASS_NAME, subject: SUBJECTS.math.name,
            type: ASSIGNMENT.type, date, title: ASSIGNMENT.title,
            score, max: ASSIGNMENT.maxScore, notes: '',
            assignmentId: ASSIGNMENT.id, historyLogs: [], createdAt: ts,
        });
    });

    // 4. Lessons (Document format, same shape as assets/js/lessons.js createLesson())
    LESSONS.forEach((l, i) => {
        const s = SUBJECTS[l.subject];
        // split lesson model (contentVersion 2): metadata doc + content/main
        batch.set(lessonRefs[i], {
            ...TAG,
            title: l.title, format: 'document', status: 'published',
            schoolId: SCHOOL, classId: CLASS_ID, className: CLASS_NAME,
            subjectId: s.id, subjectName: s.name,
            authorId: AUTHOR.authorId, authorName: AUTHOR.authorName,
            slideCount: 1, contentVersion: 2,
            createdAt: ts, updatedAt: ts, publishedAt: ts,
        });
        batch.set(lessonRefs[i].collection('content').doc('main'), {
            ...TAG,
            slides: [{ id: rid('slide'), type: 'richtext', contentHtml: l.contentHtml }],
            theme: 'general', updatedAt: ts,
        });
    });

    await batch.commit();

    console.log(`[OK]   subjects: ${SUBJECTS.math.name}, ${SUBJECTS.ela.name}`);
    console.log(`[OK]   assignment: ${ASSIGNMENT.title} (semester ${semesterId})`);
    for (const [id, name, score] of results) console.log(`[OK]   graded ${id.padEnd(10)} ${String(name || '').padEnd(16)} ${score}/100`);
    for (const l of LESSONS) console.log(`[OK]   lesson ${SUBJECTS[l.subject].name}: ${l.title}`);

    await gradeEverySubject(students, semesterId);
    console.log('[DONE]');
}

// ── EVERY SUBJECT: one graded assignment per subject, every student ─────────
// Covers new-model subjects in QA-CLASS-01 AND the teacher's legacy embedded
// subjects (teachers/T99-QA001.subjects[], e.g. the ds1–ds8 defaults), using
// the same merge rule as utils.js loadTeacherSubjectsCache(): a legacy subject
// is hidden when a new-model subject has the same name.
// null = subject already graded above; unknown names get the generic entry.
const SUBJECT_ASSIGNMENTS = {
    '4th Grade Math': null,
    '4th Grade Language Arts': { title: 'Nouns Identification Worksheet', type: 'Assignment', max: 20, instructions: 'Underline every noun and label it common, proper, or abstract.' },
    'Mathematics': { title: 'Place Value to 100,000 Quiz', type: 'Quiz', max: 20, instructions: 'Write each number in standard, expanded, and word form.' },
    'English Language Arts': { title: 'Reading Comprehension Check - Unit 1', type: 'Quiz', max: 25, instructions: 'Read the passage and answer the questions in complete sentences.' },
    'Science': { title: 'States of Matter Lab Report', type: 'Project', max: 50, instructions: 'Record your observations of ice melting and water evaporating. Explain each change of state.' },
    'Social Studies': { title: 'Map Skills: Districts of Belize', type: 'Assignment', max: 30, instructions: 'Label all six districts and their capitals. Add a compass rose and a key.' },
    'Spanish': { title: 'Vocabulario: La Familia', type: 'Quiz', max: 20, instructions: 'Match each family word to its English meaning, then write three sentences about your family.' },
    'Art': { title: 'Color Wheel Project', type: 'Project', max: 25, instructions: 'Paint a 12-part color wheel showing primary, secondary, and tertiary colors.' },
    'Physical Education': { title: 'Fitness Circuit Assessment', type: 'Test', max: 20, instructions: 'Complete the five-station circuit: jumping jacks, sit-ups, shuttle run, skipping, and balance.' },
    'Health & Family Life': { title: 'Healthy Plate Food Journal', type: 'Homework', max: 20, instructions: 'Log your meals for three days and sort each food into the healthy plate groups.' },
};
const GENERIC_ASSIGNMENT = { title: 'Unit 1 Check', type: 'Quiz', max: 20, instructions: 'Answer all questions. Show your work.' };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function gradeEverySubject(students, semesterId) {
    const teacherRef = db.collection('teachers').doc(AUTHOR.authorId);
    const [teacherSnap, newSnap] = await Promise.all([teacherRef.get(), classRef.collection('subjects').get()]);
    if (!teacherSnap.exists) throw new Error(`${teacherRef.path} not found. Run: node seed-test-accounts.js`);
    if (teacherSnap.get('_qaSeed') !== true) throw new Error(`Refusing to modify untagged ${teacherRef.path}`);

    const newSubjects = newSnap.docs.filter((d) => !d.get('archived')).map((d) => ({ id: d.id, name: d.get('name'), source: 'new' }));
    const newNames = new Set(newSubjects.map((s) => s.name));
    const legacyAll = teacherSnap.get('subjects') || [];
    const legacySubjects = legacyAll.filter((s) => !s.archived && !newNames.has(s.name)).map((s) => ({ id: s.id, name: s.name, source: 'legacy' }));

    const date = today();
    const ts = nowIso();
    const batch = db.batch();
    const legacyAssignments = new Map(); // legacy subject id -> assignment object
    const gradeRefs = [];
    const summary = [];

    for (const sub of [...newSubjects, ...legacySubjects]) {
        const spec = Object.prototype.hasOwnProperty.call(SUBJECT_ASSIGNMENTS, sub.name) ? SUBJECT_ASSIGNMENTS[sub.name] : GENERIC_ASSIGNMENT;
        if (!spec) continue;

        const asgId = `qa-asg-${slug(sub.name)}-u1`;
        const asg = {
            ...TAG, id: asgId, title: spec.title, type: spec.type, maxScore: spec.max,
            description: spec.instructions, instructions: spec.instructions, date, completed: true, createdAt: ts,
        };

        let asgRef = null;
        if (sub.source === 'new') {
            asgRef = classRef.collection('subjects').doc(sub.id).collection('assignments').doc(asgId);
            batch.set(asgRef, asg);
        } else {
            legacyAssignments.set(sub.id, asg);
        }

        for (const st of students) {
            const score = Math.round((spec.max * randInt(72, 100)) / 100);
            const gRef = db.collection('students').doc(st.id).collection('grades').doc(`qa-grd-${asgId}`);
            gradeRefs.push(gRef);
            batch.set(gRef, {
                ...TAG,
                schoolId: SCHOOL, teacherId: AUTHOR.authorId, semesterId,
                className: st.className || CLASS_NAME, subject: sub.name,
                type: spec.type, date, title: spec.title,
                score, max: spec.max, notes: '',
                assignmentId: asgId, historyLogs: [], createdAt: ts,
            });
            if (asgRef) {
                batch.set(asgRef.collection('submissions').doc(st.id), {
                    ...TAG,
                    studentId: st.id, studentName: st.name || '',
                    assignmentId: asgId, assignmentTitle: spec.title, workType: spec.type,
                    subjectId: sub.id, subjectName: sub.name,
                    classId: CLASS_ID, className: CLASS_NAME,
                    responseText: 'Completed.', linkUrl: null,
                    status: 'graded', submittedAt: ts, updatedAt: ts,
                });
            }
        }
        summary.push(`${sub.name} (${sub.source}): ${spec.title} /${spec.max}`);
    }

    await assertWritable(gradeRefs);

    if (legacyAssignments.size) {
        const subjects = legacyAll.map((s) => {
            const asg = legacyAssignments.get(s.id);
            if (!asg) return s;
            const others = (Array.isArray(s.assignments) ? s.assignments : []).filter((a) => a.id !== asg.id);
            return { ...s, assignments: [...others, asg] };
        });
        batch.update(teacherRef, { subjects });
    }

    await batch.commit();
    for (const line of summary) console.log(`[OK]   graded all ${students.length} students: ${line}`);
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(`[FAIL] ${e.message}`);
    process.exit(1);
});
