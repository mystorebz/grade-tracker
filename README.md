# 📚 Grade Tracker — School Portal

A professional, lightweight grade tracking system built for schools. Supports multiple teachers, students, parents, and an administrator — all from a single HTML file backed by Firebase Firestore.

---

## 🎯 What it does

- **Admin** — Manages teachers, views all students and grades system-wide, manages grading periods (semesters)
- **Teacher** — Manages their own students, enters grades by semester, tracks class performance, adds notes to every grade
- **Student / Parent** — Logs in with a PIN to view grades by subject and semester, including teacher notes and change history

---

## ✨ Features

- Multi-semester / grading period support (Semester 1, Midterm, Semester 2, Semester 3)
- Grade entry with teacher notes — visible to parents
- Grade change history with mandatory timestamped reasons
- Student archiving (grades preserved)
- Teacher archiving
- Color-coded performance indicators (At Risk, Needs Attention, On Track, Good, Excelling)
- Grades below 65% highlighted in red
- Printable grade reports per student
- Inline grade editing with cumulative note history
- Admin view of all students and teachers system-wide
- Fully responsive — works on desktop, tablet, and mobile
- No app installation required — runs in any browser

---

## 🛠 Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript (single file) |
| Database | Firebase Firestore |
| Hosting | GitHub Pages |
| Cost | Free (Firebase Spark plan) to ~$5/month at scale |

---

## 🚀 Setup instructions

### 1. Firebase setup

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create a new project
3. Enable **Firestore Database** → Start in test mode
4. Go to **Project Settings → Your apps → Web app** and copy the `firebaseConfig` object

### 2. Configure the app

Open `index.html` and find the Firebase config section near the top of the script:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

Replace the placeholder values with your actual Firebase config keys.

### 3. Deploy to GitHub Pages

1. Push `index.html` to this repository as the main file
2. Go to **Settings → Pages**
3. Set branch to `main` and click **Save**
4. Your site will be live at `https://yourusername.github.io/grade-tracker`

---

## 🔐 Default login

| Role | Default code |
|---|---|
| Admin | `ADMIN2024` |
| Teacher | Set by admin when creating teacher account |
| Student / Parent | PIN set by teacher (4–6 digits) |

> ⚠️ Change the admin login code immediately after first login via Admin → Settings.

---

## 👥 User roles

### Administrator
- Creates and manages teacher accounts
- Views all students and grades across all teachers
- Manages grading periods / semesters
- Archives or removes teachers and students
- Changes admin login code

### Teacher
- Selects their class on first login (Infant 1 through Standard 6)
- Adds and manages their own students
- Enters grades by subject, type, and semester
- Adds notes and comments to every grade (visible to parents)
- Must provide a reason when editing a grade (timestamped and logged)
- Resets student PINs
- Archives students (grades preserved)
- Prints grade reports

### Student / Parent
- Logs in with a 4–6 digit PIN provided by the teacher
- Views grades by semester
- Views grades by subject with all assignments listed
- Sees teacher notes and full change history on every grade
- Sees a clear disclaimer that averages are estimates and may not reflect final grades

---

## 📋 Grade types supported

- Test
- Quiz
- Assignment
- Midterm Exam
- Final Exam
- Project
- Homework

---

## 🎨 Grade color coding

| Range | Grade | Color |
|---|---|---|
| 90–100% | A | Green |
| 80–89% | B | Blue |
| 70–79% | C | Teal |
| 65–69% | D | Amber |
| Below 65% | F | Red |

---

## 📅 Grading periods

Default periods (configurable by admin):
- Semester 1
- Midterm
- Semester 2
- Semester 3

---

## 🔒 Firestore security

After initial setup in test mode, update your Firestore security rules in the Firebase console to restrict access:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true; // Tighten this for production
    }
  }
}
```

For production, work with a developer to implement proper security rules that restrict read/write access appropriately.

---

## 📈 Scaling to multiple schools

This repository supports a single school instance. To deploy for multiple schools:

- Create a separate Firebase project per school, OR
- Contact the developer to implement a multi-tenant version with a central super-admin dashboard

---

## 📄 License

This project is proprietary. Unauthorized copying, distribution, or use without permission is not allowed.

---

## 🤝 Support

For setup assistance, feature requests, or to deploy this system for your school, contact the developer directly.
