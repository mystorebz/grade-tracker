// ── CLASS STREAM: DISCUSSION PAGE (student) ──────────────────────────────
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { loadSchoolHeaderInfo } from '../../assets/js/utils.js';
import { lessonViewerUrl } from '../../assets/js/posts.js';
import { initDiscussionPage } from '../../assets/js/stream-discussion.js';

const session = requireAuth('student', '../login.html');

if (session) {
    injectStudentLayout('stream', 'Class Stream', 'Discussion');
    loadSchoolHeaderInfo(session.schoolId).then(({ schoolName, semesterName }) => {
        const schoolEl = document.getElementById('displaySchoolName');
        const semEl = document.getElementById('activeSemesterDisplay');
        if (schoolEl) schoolEl.textContent = schoolName;
        if (semEl) semEl.textContent = semesterName;
    });

    initDiscussionPage({
        schoolId: session.schoolId,
        author: { authorId: session.studentId, authorName: session.studentData?.name || 'Student', role: 'student' },
        canComment: true,
        canDelete: () => false,
        backHref: ({ postId }) => `stream.html?${new URLSearchParams({ focus: postId || '' }).toString()}`,
        ctaHtml: (post) => {
            if (!post.linkedLessonId) return '';
            const live = post.type === 'live_session' && post.live;
            const ended = post.type === 'live_session' && !post.live;
            return `<a href="${lessonViewerUrl(post)}" class="inline-flex items-center gap-2 mt-3 ${live ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'} text-white font-black py-2 px-4 rounded-lg transition text-[13px]"><i class="fa-solid ${live ? 'fa-tower-broadcast' : 'fa-arrow-right'} text-[11px]"></i>${live ? 'Join Live Lesson' : ended ? 'Review Lesson' : 'Open Lesson'}</a>`;
        },
    });
}
