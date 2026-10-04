#!/usr/bin/env node
'use strict';
/**
 * functions/seed-qa-quiz.js — QA demo data for the Current Grades subject page,
 * LIVE dev project.
 *
 *   node seed-qa-quiz.js            create (or refresh) the graded quiz
 *   node seed-qa-quiz.js --cleanup  remove everything this script created
 *
 * Creates a fully graded, question-based quiz for QA Student (S99-QA001) in
 * QA Class 1 → 4th Grade Language Arts, so a person can see on dev:
 *   • the subject page's type filter cards (this adds a "Quiz" next to the
 *     existing "Assignment", so the subject has two types)
 *   • the assignment panel's question-by-question view: multiple-choice
 *     answers marked Correct / Incorrect, written answers, per-question
 *     points, teacher notes on individual questions, an overall comment.
 *
 * Documents (all tagged _qaSeed: true; --cleanup refuses to touch anything
 * at these paths that is not tagged):
 *   schools/QA-SCHOOL-01/classes/QA-CLASS-01/subjects/QA-SUBJ-ELA4/assignments/qa-asg-ela4-pos-quiz
 *     …/submissions/S99-QA001                 the student's answers + auto-grade
 *   work_answer_keys/qa-asg-ela4-pos-quiz     multiple-choice key (server-only)
 *   students/S99-QA001/grades/qa-grd-ela4-pos-quiz   7 / 10, per-question marks
 *
 * No email fields anywhere, so no notification mail is sent.
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 */
const PROJECT_ID = 'dev-school-grade-tracker';
if ((process.env.QA_PROJECT_ID || PROJECT_ID) !== PROJECT_ID) {
    console.error(`[FAIL] Refusing to run against anything but ${PROJECT_ID}.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'qa-seed-quiz');
const db = getFirestore(app);

const SCHOOL = 'QA-SCHOOL-01';
const CLASS = 'QA-CLASS-01';
const CLASS_NAME = 'QA Class 1';
const SUBJECT_ID = 'QA-SUBJ-ELA4';
const SUBJECT_NAME = '4th Grade Language Arts';
const SEMESTER = 'QA-SEM-01';
const TEACHER = 'T99-QA001';
const STUDENT = 'S99-QA001';
const STUDENT_NAME = 'QA Student';
const ASG = 'qa-asg-ela4-pos-quiz';
const GRADE = 'qa-grd-ela4-pos-quiz';
const TAG = { _qaSeed: true, _seededBy: 'functions/seed-qa-quiz.js' };

const ASG_PATH = `schools/${SCHOOL}/classes/${CLASS}/subjects/${SUBJECT_ID}/assignments/${ASG}`;
const SUB_PATH = `${ASG_PATH}/submissions/${STUDENT}`;
const KEY_PATH = `work_answer_keys/${ASG}`;
const GRADE_PATH = `students/${STUDENT}/grades/${GRADE}`;
const PATHS = [SUB_PATH, KEY_PATH, GRADE_PATH, ASG_PATH]; // submission first, assignment last

const QUESTIONS = [
    { id: 'q_1', type: 'multiple_choice', points: 2, hint: '', attachments: [],
      prompt: 'Which word is a PROPER noun?',
      options: ['river', 'Belize City', 'happiness', 'dog'] },
    { id: 'q_2', type: 'multiple_choice', points: 2, hint: '', attachments: [],
      prompt: 'Which word is an ABSTRACT noun?',
      options: ['table', 'courage', 'teacher', 'pencil'] },
    { id: 'q_3', type: 'short_answer', points: 2, hint: 'One word.', attachments: [],
      prompt: "Write the plural of the noun 'child'." },
    { id: 'q_4', type: 'free_response', points: 4, hint: 'Two complete sentences.', attachments: [],
      prompt: 'Write two sentences: one using a common noun and one using a proper noun. Name the nouns you used.' },
];
const KEYS = { q_1: 1, q_2: 1 }; // correct option index per multiple-choice question

const RESPONSES = [
    { questionId: 'q_1', responseText: '1' },   // Belize City — correct
    { questionId: 'q_2', responseText: '2' },   // teacher — incorrect (courage)
    { questionId: 'q_3', responseText: 'children' },
    { questionId: 'q_4', responseText: 'My dog likes to run in the park. (common noun: dog)\nWe visited belize city last summer. (proper noun: Belize City)' },
];

const PER_QUESTION = {
    q_1: { score: 2, note: '' },
    q_2: { score: 0, note: '"Teacher" is a person you can see. "Courage" is the abstract noun — it is an idea you cannot touch.' },
    q_3: { score: 2, note: 'Perfect!' },
    q_4: { score: 3, note: 'Good sentences and you named both nouns. Remember: proper nouns start with a capital letter — "Belize City".' },
};
const SCORE = Object.values(PER_QUESTION).reduce((s, q) => s + q.score, 0); // 7
const MAX = QUESTIONS.reduce((s, q) => s + q.points, 0);                     // 10

async function assertQaOwned(p) {
    const snap = await db.doc(p).get();
    if (snap.exists && snap.get('_qaSeed') !== true) throw new Error(`${p} exists and is NOT a QA document — refusing to touch it.`);
    return snap;
}

async function seed() {
    for (const p of PATHS) await assertQaOwned(p);
    const now = new Date();
    const iso = now.toISOString();
    const day = iso.slice(0, 10);

    await db.doc(ASG_PATH).set({
        ...TAG,
        id: ASG, title: 'Parts of Speech Quiz', type: 'Quiz', category: 'assessment',
        instructions: 'Answer every question. For the last question, write two complete sentences and name the nouns you used.',
        description: 'Quiz on common, proper and abstract nouns.',
        maxScore: MAX, date: `${day}T06:00:00.000Z`, createdAt: iso, updatedAt: iso,
        locked: false, lockedAt: null, completed: true, attachments: [],
        questions: QUESTIONS, teacherId: TEACHER,
    });
    await db.doc(KEY_PATH).set({ ...TAG, keys: KEYS, assignmentId: ASG, updatedAt: iso });

    // Auto-grade block exactly as autoGradeWorkSubmission would compute it, so
    // the trigger's own "unchanged" guard skips re-writing it.
    const perQuestion = { q_1: true, q_2: false };
    await db.doc(SUB_PATH).set({
        ...TAG,
        studentId: STUDENT, studentName: STUDENT_NAME,
        assignmentId: ASG, assignmentTitle: 'Parts of Speech Quiz', workType: 'Quiz',
        classId: CLASS, className: CLASS_NAME, subjectId: SUBJECT_ID, subjectName: SUBJECT_NAME,
        responses: RESPONSES, responseText: '', linkUrl: null,
        status: 'graded', submittedAt: iso, updatedAt: iso,
        objectiveAutoGrade: { points: 2, maxObjectivePoints: 4, correctCount: 1, totalObjective: 2, perQuestion, gradedAt: iso },
    });

    await db.doc(GRADE_PATH).set({
        ...TAG,
        schoolId: SCHOOL, semesterId: SEMESTER,
        classId: CLASS, className: CLASS_NAME, subjectId: SUBJECT_ID, subject: SUBJECT_NAME,
        teacherId: TEACHER, assignmentId: ASG,
        title: 'Parts of Speech Quiz', type: 'Quiz',
        score: SCORE, max: MAX, date: day, createdAt: iso,
        notes: 'Nice work overall, QA Student! Review abstract nouns (ideas and feelings) before the unit test.',
        // Teacher marks per question: { score, note } (read by the assignment panel).
        perQuestion: PER_QUESTION, historyLogs: [],
    });

    console.log(`[PASS] assignment  ${ASG_PATH}`);
    console.log(`[PASS] answer key  ${KEY_PATH}`);
    console.log(`[PASS] submission  ${SUB_PATH}`);
    console.log(`[PASS] grade       ${GRADE_PATH}  (${SCORE}/${MAX})`);
    console.log('\nSee it on dev:');
    console.log(`  Student (S99-QA001): https://${PROJECT_ID}.web.app/student/grades/subject.html?subject=${encodeURIComponent(SUBJECT_NAME)}&item=${GRADE}`);
    console.log(`  Parent  (P99-QA001): https://${PROJECT_ID}.web.app/parent/grades/subject.html?student=${STUDENT}&subject=${encodeURIComponent(SUBJECT_NAME)}&item=${GRADE}`);
    console.log(`  Teacher (T99-QA001): https://${PROJECT_ID}.web.app/teacher/subjects/subject.html?c=${CLASS}&s=${SUBJECT_ID}&tab=assignments`);
}

async function cleanup() {
    for (const p of PATHS) {
        const snap = await assertQaOwned(p);
        if (snap.exists) { await db.doc(p).delete(); console.log(`[PASS] deleted ${p}`); }
        else console.log(`[INFO] not present ${p}`);
    }
}

(process.argv.includes('--cleanup') ? cleanup() : seed())
    .then(() => process.exit(0))
    .catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
