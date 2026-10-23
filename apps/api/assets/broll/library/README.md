# B-roll Library

This directory contains pre-downloaded B-roll clips organized by category.
Each subdirectory maps to keywords in BROLL_KEYWORD_MAP.

## Structure
```
library/
├── business/       - Office, corporate, meeting clips
├── money/          - Finance, cash, investment clips
├── nature/         - Nature scenes, landscapes
├── food/           - Cooking, restaurants, dining
├── tech/           - Technology, coding, computers
├── people/         - People, crowds, social scenes
├── success/        - Achievement, celebration, victory
├── travel/         - Travel, adventure, city scenes
├── workout/        - Fitness, gym, exercise
├── crypto/         - Cryptocurrency, blockchain
├── time/           - Clocks, calendars, scheduling
└── manifest.json   - Category to files mapping
```

## Adding Clips
Place video files in the appropriate category subdirectory.
Update manifest.json with the new filenames.

## Download Script
```bash
npx tsx scripts/download-broll-library.ts
```
