// ── CLASS STREAM: DISCUSSION PAGE (teacher) ──────────────────────────────
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { initDiscussionPage } from '../../assets/js/stream-discussion.js';
import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const session = requireAuth('teacher', '../login.html');

function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

if (session) {
    injectTeacherLayout('stream', 'Class Stream', 'Discussion', false);
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('displayTeacherName', session.teacherData.name);
    setText('teacherAvatar', (session.teacherData.name || '?').charAt(0).toUpperCase());
    setText('sidebarSchoolId', session.schoolId);
    const classesEl = document.getElementById('displayTeacherClasses');
    if (classesEl) {
        const classes = session.teacherData.classes || [session.teacherData.className || ''];
        classesEl.innerHTML = classes.filter(Boolean).map(c => `<span class="class-pill">${esc(c)}</span>`).join('');
    }

    initDiscussionPage({
        schoolId: session.schoolId,
        author: { authorId: session.teacherId, authorName: session.teacherData.name, role: 'teacher' },
        canComment: true,
        canDelete: () => true,
        backHref: ({ subjectId, postId }) => `stream.html?${new URLSearchParams({ subject: subjectId || '', focus: postId || '' }).toString()}`,
        // Same banners as the teacher stream card.
        ctaHtml: (post) => {
            if (post.type === 'live_session') {
                return post.live
                    ? `<a href="../lessons/live.html?${new URLSearchParams({ lessonId: post.linkedLessonId, classId: post.classId, subjectId: post.subjectId, subjectName: post.subjectName || '' }).toString()}" class="inline-flex items-center gap-1.5 mt-3 bg-[#0d1f35] hover:bg-[#2563eb] text-white font-bold py-1.5 px-3 rounded transition text-[12px]"><i class="fa-solid fa-tower-broadcast text-[10px]"></i>Return to Live Presenter</a>`
                    : `<div class="mt-3"><span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-[#6b84a0] bg-[#f0f4f8] px-2 py-1 rounded border border-[#dce3ed]"><i class="fa-solid fa-circle-stop text-[9px]"></i>Session ended</span></div>`;
            }
            if (post.linkedLessonId) {
                return `<div class="mt-3"><span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-[#2563eb] bg-[#eef4ff] px-2 py-1 rounded border border-[#c7d9fd]"><i class="fa-solid fa-person-chalkboard text-[10px]"></i>Lesson post · students see an Open Lesson button</span></div>`;
            }
            return '';
        },
        // Poll "Not voted yet" list — same roster source as the stream page.
        loadRoster: async (post) => {
            const snap = await getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId), where('enrollmentStatus', '==', 'Active')));
            return snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .filter(s => s.classId ? s.classId === post.classId : (!!post.className && s.className === post.className))
                .map(s => ({ id: s.id, name: s.name || s.id }))
                .sort((a, b) => a.name.localeCompare(b.name));
        },
    });
}
