# InstaAutoDM Cron Job

This is a cron job for InstaAutoDM that runs on Render.com. It checks for new comments on Instagram posts and sends direct messages based on automation rules.

## Setup on Render.com

1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Configure the service:
   - Name: instaautodm-cron
   - Environment: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Add the following environment variables:
     - MONGODB_URI: Your MongoDB connection string
     - APP_URL: Your Vercel app URL

4. Set up a cron job in the Render dashboard:
   - Go to your service settings
   - Click on "Cron Jobs"
   - Add a new cron job with the schedule: `0 * * * *` (runs every hour)
   - Command: `node index.js`

## Local Development

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in your environment variables
3. Run `npm install`
4. Run `npm run dev` to start the cron job locally

## How It Works

The cron job:
1. Connects to your MongoDB database
2. Fetches all active automations
3. For each automation, checks for new comments on the associated Instagram post
4. If a comment contains the trigger keyword, sends a direct message to the commenter
5. Updates the automation stats in the database

This allows your InstaAutoDM app to run automated tasks even though Vercel doesn't support long-running background processes.
