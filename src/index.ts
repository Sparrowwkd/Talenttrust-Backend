import { createApp } from './app';

const port = Number(process.env.PORT) || 3001;

if (require.main === module) {
  createApp().listen(port, () => {
    console.log(`TalentTrust API listening on http://localhost:${port}`);
  });
}

export { createApp };
