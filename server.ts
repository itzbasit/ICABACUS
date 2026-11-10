import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import {
  INITIAL_LEVELS,
  INITIAL_USERS,
  INITIAL_TESTS,
  INITIAL_RESULTS,
  INITIAL_ACHIEVEMENTS,
  INITIAL_NOTIFICATIONS,
} from './src/data/initialData';
import { generateQuestionForLevel, generateTestQuestions } from './src/utils/mathEngine';
import { TestResult, StudentAnswer } from './src/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// AI Studio dev server runs strictly on port 3000.
// Cloud Run injects PORT=8080 which is reserved by the container supervisor, so ignore process.env.PORT.
const portArgIndex = process.argv.indexOf('--port');
const PORT = portArgIndex !== -1 ? parseInt(process.argv[portArgIndex + 1], 10) : 3000;
const isProd = process.env.NODE_ENV === 'production';

// Ensure data folder and file persistence
const DATA_DIR = path.resolve(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'ic_abacus_db.json');

interface DatabaseSchema {
  users: typeof INITIAL_USERS;
  levels: typeof INITIAL_LEVELS;
  tests: typeof INITIAL_TESTS;
  results: typeof INITIAL_RESULTS;
  achievements: typeof INITIAL_ACHIEVEMENTS;
  notifications: typeof INITIAL_NOTIFICATIONS;
}

function loadDatabase(): DatabaseSchema {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        users: parsed.users || INITIAL_USERS,
        levels: parsed.levels || INITIAL_LEVELS,
        tests: parsed.tests || INITIAL_TESTS,
        results: parsed.results || INITIAL_RESULTS,
        achievements: parsed.achievements || INITIAL_ACHIEVEMENTS,
        notifications: parsed.notifications || INITIAL_NOTIFICATIONS,
      };
    }
  } catch (err) {
    console.error('Error loading database, resetting to initial data:', err);
  }

  const initialDb: DatabaseSchema = {
    users: INITIAL_USERS,
    levels: INITIAL_LEVELS,
    tests: INITIAL_TESTS,
    results: INITIAL_RESULTS,
    achievements: INITIAL_ACHIEVEMENTS,
    notifications: INITIAL_NOTIFICATIONS,
  };
  saveDatabase(initialDb);
  return initialDb;
}

function saveDatabase(data: DatabaseSchema): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save database file:', err);
  }
}

let db = loadDatabase();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // API Routes
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Bootstrap full app state
  app.get('/api/bootstrap', (req: Request, res: Response) => {
    res.json({
      users: db.users,
      levels: db.levels,
      tests: db.tests,
      results: db.results,
      achievements: db.achievements,
      notifications: db.notifications,
    });
  });

  // Auth: Login
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { identifier, password, role } = req.body;
    if (!identifier) {
      return res.status(400).json({ error: 'Username/Email/Reg Number is required' });
    }

    const cleanId = String(identifier).trim().toLowerCase();
    const user = db.users.find(u => {
      const matchRole = !role || u.role === role;
      const matchIdentifier =
        u.email.toLowerCase() === cleanId ||
        u.regNumber.toLowerCase() === cleanId ||
        u.mobile === cleanId ||
        (cleanId === 'admin' && u.role === 'admin');
      return matchRole && matchIdentifier;
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found. Please check your credentials.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'This account has been deactivated. Please contact Career Ready J&K administrator.' });
    }

    res.json({ user, token: `fake-token-${user.id}` });
  });

  // Auth: Register Student
  app.post('/api/auth/register', (req: Request, res: Response) => {
    const { name, school, classGrade, mobile, email, password } = req.body;
    if (!name || !school || !mobile) {
      return res.status(400).json({ error: 'Name, School, and Mobile are required' });
    }

    const existing = db.users.find(
      u => (email && u.email.toLowerCase() === String(email).toLowerCase()) || u.mobile === mobile
    );
    if (existing) {
      return res.status(400).json({ error: 'An account with this mobile number or email already exists' });
    }

    const regSuffix = Math.floor(100 + Math.random() * 900);
    const regNumber = `CR-JK-2026-${regSuffix}`;
    const newUser = {
      id: `u_student_${Date.now()}`,
      role: 'student' as const,
      name: name.trim(),
      email: (email || `${mobile}@student.careerreadyjk.com`).trim(),
      regNumber,
      school: school.trim(),
      classGrade: classGrade || 'Grade 5',
      mobile: mobile.trim(),
      currentLevel: 1,
      highestLevelUnlocked: 1,
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    db.users.push(newUser);
    saveDatabase(db);
    res.status(201).json({ user: newUser, token: `fake-token-${newUser.id}` });
  });

  // Auth: Reset password
  app.post('/api/auth/reset-password', (req: Request, res: Response) => {
    const { identifier } = req.body;
    const cleanId = String(identifier || '').trim().toLowerCase();
    const user = db.users.find(
      u => u.email.toLowerCase() === cleanId || u.regNumber.toLowerCase() === cleanId || u.mobile === cleanId
    );
    if (!user) {
      return res.status(404).json({ error: 'No account registered with that email or ID.' });
    }
    res.json({ success: true, message: `Password reset link sent to registered contact for ${user.name}` });
  });

  // Levels API
  app.get('/api/levels', (req: Request, res: Response) => {
    res.json(db.levels);
  });

  app.put('/api/levels/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const index = db.levels.findIndex(l => l.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Level not found' });
    }
    db.levels[index] = { ...db.levels[index], ...req.body };
    saveDatabase(db);
    res.json(db.levels[index]);
  });

  app.post('/api/levels', (req: Request, res: Response) => {
    const nextLevelNum = db.levels.length + 1;
    const newLevel = {
      id: nextLevelNum,
      levelNumber: nextLevelNum,
      name: req.body.name || `Level ${nextLevelNum}: Custom Mental Arithmetic`,
      description: req.body.description || 'Custom administrator configured level.',
      difficulty: req.body.difficulty || 'Intermediate',
      operations: req.body.operations || ['addition', 'subtraction'],
      minQualifyingScore: req.body.minQualifyingScore || 75,
      isLocked: req.body.isLocked ?? true,
      maxDigits: req.body.maxDigits || 2,
      numbersPerCalculation: req.body.numbersPerCalculation || 2,
      allowNegativeAnswers: false,
      allowCarryBorrow: true,
      timeLimitPerQuestionSec: req.body.timeLimitPerQuestionSec || 20,
      topicsCovered: req.body.topicsCovered || ['Custom Drills'],
    };
    db.levels.push(newLevel);
    saveDatabase(db);
    res.status(201).json(newLevel);
  });

  // Tests API
  app.get('/api/tests', (req: Request, res: Response) => {
    res.json(db.tests);
  });

  app.post('/api/tests', (req: Request, res: Response) => {
    const newTest = {
      id: `test_${Date.now()}`,
      createdAt: new Date().toISOString(),
      isPublished: true,
      maxAttempts: 3,
      reviewAnswersAllowed: true,
      ...req.body,
    };
    db.tests.push(newTest);
    saveDatabase(db);
    res.status(201).json(newTest);
  });

  app.put('/api/tests/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const index = db.tests.findIndex(t => t.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Test not found' });
    }
    db.tests[index] = { ...db.tests[index], ...req.body };
    saveDatabase(db);
    res.json(db.tests[index]);
  });

  app.delete('/api/tests/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    db.tests = db.tests.filter(t => t.id !== id);
    saveDatabase(db);
    res.json({ success: true });
  });

  // Generate Questions for a test
  app.get('/api/tests/:id/questions', (req: Request, res: Response) => {
    const test = db.tests.find(t => t.id === req.params.id);
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }
    const level = db.levels.find(l => l.levelNumber === test.levelNumber) || db.levels[0];
    const questions = generateTestQuestions(level, test.totalQuestions, test.operation);
    res.json({ questions, test });
  });

  // Submit test answers
  app.post('/api/tests/:id/submit', (req: Request, res: Response) => {
    const test = db.tests.find(t => t.id === req.params.id);
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    const {
      studentId,
      studentName,
      studentSchool,
      studentRegNumber,
      answers,
      timeTakenSec,
    } = req.body;

    let correctCount = 0;
    let incorrectCount = 0;
    let unattemptedCount = 0;
    const evaluatedAnswers: StudentAnswer[] = [];

    const opStats: Record<string, { correct: number; total: number }> = {};

    (answers as any[]).forEach(ans => {
      const op = ans.operation || '+';
      if (!opStats[op]) opStats[op] = { correct: 0, total: 0 };
      opStats[op].total += 1;

      const isAttempted = ans.studentAnswer !== null && ans.studentAnswer !== undefined && ans.studentAnswer !== '';
      const isCorrect = isAttempted && Number(ans.studentAnswer) === Number(ans.correctAnswer);

      if (!isAttempted) {
        unattemptedCount += 1;
      } else if (isCorrect) {
        correctCount += 1;
        opStats[op].correct += 1;
      } else {
        incorrectCount += 1;
      }

      evaluatedAnswers.push({
        questionId: ans.questionId,
        expression: ans.expression,
        operation: op,
        studentAnswer: isAttempted ? Number(ans.studentAnswer) : null,
        correctAnswer: Number(ans.correctAnswer),
        isCorrect,
        timeSpentSec: Number(ans.timeSpentSec || 0),
      });
    });

    const marksPerQ = test.marksPerQuestion || 2;
    const negMarks = test.negativeMarking || 0;
    const maxMarks = test.totalQuestions * marksPerQ;
    const rawMarks = (correctCount * marksPerQ) - (incorrectCount * negMarks);
    const totalMarksObtained = Math.max(0, Math.round(rawMarks * 10) / 10);
    const percentage = Math.round((correctCount / (test.totalQuestions || 1)) * 1000) / 10;
    const isPassed = percentage >= test.passingPercentage;
    const avgTimePerQuestion = Math.round(((timeTakenSec || 60) / (test.totalQuestions || 1)) * 10) / 10;

    const operationBreakdown = Object.entries(opStats).map(([op, stat]) => ({
      operation: op,
      correct: stat.correct,
      total: stat.total,
      accuracy: stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0,
    }));

    const resultId = `res_${Date.now()}`;
    const newResult: TestResult = {
      id: resultId,
      testId: test.id,
      testTitle: test.title,
      studentId,
      studentName,
      studentRegNumber,
      studentSchool,
      levelNumber: test.levelNumber,
      totalQuestions: test.totalQuestions,
      correctCount,
      incorrectCount,
      unattemptedCount,
      totalMarksObtained,
      maxMarks,
      percentage,
      timeTakenSec: Number(timeTakenSec || 0),
      averageTimePerQuestionSec: avgTimePerQuestion,
      isPassed,
      operationBreakdown,
      answers: evaluatedAnswers,
      submittedAt: new Date().toISOString(),
    };

    db.results.unshift(newResult);

    // If passed and unlocks next level for student
    let nextLevelUnlocked = false;
    const student = db.users.find(u => u.id === studentId);
    if (student && isPassed) {
      if (test.levelNumber >= student.highestLevelUnlocked) {
        student.highestLevelUnlocked = Math.min(10, test.levelNumber + 1);
        student.currentLevel = Math.min(10, test.levelNumber + 1);
        nextLevelUnlocked = true;
      }
    }

    saveDatabase(db);
    res.status(201).json({ result: newResult, nextLevelUnlocked, currentLevel: student?.currentLevel });
  });

  // Results API
  app.get('/api/results', (req: Request, res: Response) => {
    const { studentId, school, levelNumber } = req.query;
    let filtered = db.results;
    if (studentId) {
      filtered = filtered.filter(r => r.studentId === studentId);
    }
    if (school) {
      filtered = filtered.filter(r => r.studentSchool === school);
    }
    if (levelNumber) {
      filtered = filtered.filter(r => r.levelNumber === Number(levelNumber));
    }
    res.json(filtered);
  });

  // Students management (Admin)
  app.get('/api/students', (req: Request, res: Response) => {
    const students = db.users.filter(u => u.role === 'student');
    res.json(students);
  });

  app.post('/api/students', (req: Request, res: Response) => {
    const { name, email, school, classGrade, mobile, currentLevel } = req.body;
    const regSuffix = Math.floor(100 + Math.random() * 900);
    const regNumber = `CR-JK-2026-${regSuffix}`;
    const newStudent = {
      id: `u_student_${Date.now()}`,
      role: 'student' as const,
      name: name.trim(),
      email: (email || `${mobile}@student.careerreadyjk.com`).trim(),
      regNumber,
      school: school?.trim() || 'Career Ready J&K Affiliate Center',
      classGrade: classGrade || 'Grade 5',
      mobile: mobile?.trim() || '9419000000',
      currentLevel: Number(currentLevel || 1),
      highestLevelUnlocked: Number(currentLevel || 1),
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    db.users.push(newStudent);
    saveDatabase(db);
    res.status(201).json(newStudent);
  });

  app.put('/api/students/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const index = db.users.findIndex(u => u.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Student not found' });
    }
    db.users[index] = { ...db.users[index], ...req.body };
    saveDatabase(db);
    res.json(db.users[index]);
  });

  app.delete('/api/students/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    db.users = db.users.filter(u => u.id !== id);
    saveDatabase(db);
    res.json({ success: true });
  });

  // Notifications API
  app.get('/api/notifications', (req: Request, res: Response) => {
    res.json(db.notifications);
  });

  app.post('/api/notifications', (req: Request, res: Response) => {
    const newNotif = {
      id: `notif_${Date.now()}`,
      date: new Date().toISOString(),
      ...req.body,
    };
    db.notifications.unshift(newNotif);
    saveDatabase(db);
    res.status(201).json(newNotif);
  });

  // Achievements API
  app.get('/api/achievements', (req: Request, res: Response) => {
    res.json(db.achievements);
  });

  // Practice session recorder
  app.post('/api/practice/complete', (req: Request, res: Response) => {
    // Record practice session for student stats
    res.json({ success: true, recordedAt: new Date().toISOString() });
  });

  // Mount Vite or serve static files
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[IC ABACUS] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start IC ABACUS server:', err);
});
