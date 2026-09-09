# Multi-Model AI Orchestrator

ارکستراتور محلی چندمدلی برای Cursor. کار توسعه را بین Cursor Agent، OpenAI Codex، Google Gemini از طریق Antigravity، یا گردش‌کار هماهنگ TEAM مسیر‌دهی می‌کند.

نسخه فعلی: **v1.1.0**  
پلتفرم تأییدشده: **Windows**. macOS و Linux به‌عنوان میزبان پشتیبانی‌شده ادعا نمی‌شوند.

## شروع سریع

روی یک رایانهٔ Windows جدید:

```powershell
git clone https://github.com/trisha918/multi-model-ai-orchestrator.git
cd multi-model-ai-orchestrator
.\install.ps1
```

اگر Execution Policy مانع شد:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

سپس:

```powershell
ai-orchestrator doctor
```

هر پروژهٔ Git را در Cursor باز کنید:

```text
/ai Fix the login bug and add tests
```

یا:

```text
/ai-team Refactor authentication safely
```

لازم نیست مسیر clone را به خاطر بسپارید. Skillهای Cursor دستور سراسری `ai-orchestrator` را صدا می‌زنند، نه یک مسیر مطلق.

## CLI سراسری

پس از نصب، از هر پوشه‌ای در PowerShell:

```powershell
ai-orchestrator doctor
ai-orchestrator version
ai-orchestrator run --repo "C:\Projects\My App" --mode auto --commit-on-pass --task "Fix the login bug"
ai-orchestrator models
ai-orchestrator cleanup
ai-orchestrator config show
ai-orchestrator install-skills
ai-orchestrator uninstall-skills
```

اسکریپت‌های npm برای توسعه همچنان کار می‌کنند: `npm run doctor`، `npm run task`، `npm run cleanup`، `npm test`.

## نصب و حذف

`.\install.ps1` تکرارپذیر است: Git/Node/npm را بررسی می‌کند، وابستگی‌ها را نصب می‌کند، با `npm link` دستور `ai-orchestrator` را سراسری می‌کند، در صورت نیاز `%APPDATA%\npm` را **یک‌بار** به PATH کاربر اضافه می‌کند (PATH سیستم را تغییر نمی‌دهد)، Skillها را می‌نویسد و doctor را اجرا می‌کند.

Cursor، Codex، Antigravity، Git و Node را **خودکار نصب نمی‌کند**. اگر نباشند، پیام MISSING و راهنمای نصب موجود را نشان می‌دهد.

```powershell
.\uninstall.ps1
```

فقط لینک سراسری CLI و Skillهای متعلق به این پروژه حذف می‌شوند. دادهٔ config/runtime پیش‌فرض می‌ماند. برای پاک کردن آن‌ها: `.\uninstall.ps1 -PurgeData`.

## پیکربندی

مسیر: `%APPDATA%\MultiModelAIOrchestrator\config.json`

اولویت: آرگومان CLI → متغیر محیطی → فایل کاربر → انتخاب خودکار هوشمند → پیش‌فرض داخلی.

`AI_CURSOR_MODEL`، `AI_CODEX_MODEL`، `AI_GEMINI_MODEL`

## Skillهای Cursor (v1.0)

| دستور | کارگر | مدل |
| --- | --- | --- |
| `/ai` | کارگر خودکار | مدل خودکار |
| `/ai-team` | TEAM | مدل خودکار در هر مرحله |
| `/ai-cursor` | CURSOR | مدل هوشمند Cursor |
| `/ai-codex` | Codex | مدل هوشمند Codex |
| `/ai-codex-sol` | Codex | دستی: alias فعلی Sol |
| `/ai-gemini` | Gemini | مدل هوشمند Gemini |
| `/ai-gemini-pro-high` | Gemini | دستی: Pro High فعلی |
| `/ai-models` | — | نمایش مدل‌های کشف‌شده |

AUTO می‌تواند به سطح قابلیت بعدی برگردد. MANUAL اگر مدل موجود نباشد شکست می‌خورد و مدل دیگری را بی‌صدا جایگزین نمی‌کند. شناسهٔ دقیق همیشه در خروجی و `models.json` ثبت می‌شود.

`ai-orchestrator config show` / `config path` / `config set defaultMode auto`

## دادهٔ اجرا

`%LOCALAPPDATA%\MultiModelAIOrchestrator\runs\` و `worktrees\`

نسخهٔ v0.8 این پوشه‌ها را داخل clone نگه می‌داشت. v0.9 به AppData منتقل کرد تا جابه‌جایی clone مشکل نسازد. cleanup هنوز پوشه‌های قدیمی داخل clone را اگر باشند می‌شناسد.

## به‌روزرسانی

دستور `ai-orchestrator update` در v1.0 وجود ندارد.

```powershell
git pull
npm install
.\install.ps1
```

برای جابه‌جایی clone: uninstall، انتقال پوشه، سپس install از مسیر جدید.

## Skillهای قابل‌حمل

`/ai` و `/ai-team` باید `ai-orchestrator` را صدا بزنند. متن تسک به‌صورت آرگومان جداگانه پاس می‌شود. اگر Skill هم‌نام متعلق به این پروژه نباشد، بازنویسی نمی‌شود.

پروژهٔ بازشده در Cursor هدف است. اگر Git root پیدا نشود، خطا می‌دهد و مخزن دیگری حدس زده نمی‌شود.

## احراز هویت

نصب و login جدا هستند. اعتبارنامه ذخیره یا کپی نمی‌شود.

- Codex: `codex login` سپس `codex login status`
- Antigravity: ورود، سپس `agy models` بدون تغییر فایل
- Cursor Agent: `login` روی agent.cmd کشف‌شده، سپس `status`

## مسیرها و عیب‌یابی

اگر `ai-orchestrator` شناخته نشد، `.\install.ps1` پوشهٔ npm global (معمولاً `%APPDATA%\npm`) را در صورت نبودن به PATH کاربر اضافه می‌کند. ترمینال جدید باید بدون تنظیم دستی کار کند. `.\install.ps1` شیم PowerShell را هم با `@args` جایگزین می‌کند تا آرگومان‌ها به یک رشته تبدیل نشوند.

مخزن کثیف رد می‌شود؛ ارکستراتور reset خودکار نمی‌کند. بدون commit اولیه worktree ساخته نمی‌شود.

`--trust` فقط برای worktree تأییدشده است. `--yolo` سراسری فعال نمی‌شود.

## وضعیت پروژه

نسخه v1.0.0. این مخزن فعلاً فایل License ندارد.

## سلب مسئولیت

کد تولیدشده توسط AI باید قبل از استقرار واقعی بررسی و تست شود.
