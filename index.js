import dotenv from "dotenv"
import { MongoClient, ObjectId } from "mongodb"
import fetch from "node-fetch"

dotenv.config()

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI
const client = new MongoClient(MONGODB_URI)

// App URL
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://v0-instaautodm111-eight.vercel.app"

// Function to refresh an Instagram token
async function refreshInstagramToken(accessToken) {
  try {
    const response = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${accessToken}`,
    )

    if (!response.ok) {
      const errorData = await response.json()
      console.error("Failed to refresh token:", errorData)
      return null
    }

    const data = await response.json()
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    }
  } catch (error) {
    console.error("Error refreshing token:", error)
    return null
  }
}

// Function to get a valid token for an account
async function getValidTokenForAccount(db, accountId) {
  try {
    // Get the account
    const account = await db.collection("instagramAccounts").findOne({ _id: accountId })

    if (!account) {
      console.error(`Account ${accountId} not found`)
      return null
    }

    // Check if token is valid by making a simple API call
    try {
      const testResponse = await fetch(
        `https://graph.instagram.com/me?fields=id,username&access_token=${account.accessToken}`,
      )

      if (testResponse.ok) {
        return account.accessToken
      }

      console.log(`Token for ${account.username} is invalid, attempting to refresh...`)
    } catch (error) {
      console.error("Error testing token validity:", error)
    }

    // Try to refresh the token
    const refreshResult = await refreshInstagramToken(account.accessToken)

    if (!refreshResult) {
      console.error(`Failed to refresh token for ${account.username}`)
      return null
    }

    // Calculate new expiry date
    const newExpiryDate = new Date()
    newExpiryDate.setSeconds(newExpiryDate.getSeconds() + refreshResult.expiresIn)

    // Update the account with new token and expiry
    await db.collection("instagramAccounts").updateOne(
      { _id: account._id },
      {
        $set: {
          accessToken: refreshResult.accessToken,
          expiresAt: newExpiryDate,
          lastTokenRefresh: new Date(),
        },
      },
    )

    console.log(`Successfully refreshed token for ${account.username}`)
    return refreshResult.accessToken
  } catch (error) {
    console.error("Error getting valid token:", error)
    return null
  }
}

async function checkComments() {
  try {
    console.log("Starting comment check cron job...")

    await client.connect()
    console.log("Connected to MongoDB")

    const db = client.db("instaautodm")

    // Get all active automations
    const automations = await db
      .collection("automations")
      .find({
        active: true,
      })
      .toArray()

    console.log(`Found ${automations.length} active automations`)

    const totalProcessed = 0
    const totalSent = 0

    for (const automation of automations) {
      try {
        // Get the Instagram account
        const instagramAccount = await db.collection("instagramAccounts").findOne({
          _id: automation.instagramAccountId,
        })

        if (!instagramAccount) {
          console.log(`Instagram account ${automation.instagramAccountId} not found for automation ${automation._id}`)
          continue
        }

        // Get a valid token for this account
        const validToken = await getValidTokenForAccount(db, instagramAccount._id)

        if (!validToken) {
          console.error(`No valid token available for account ${instagramAccount.username}`)
          continue
        }

        // Update the token in the account object
        instagramAccount.accessToken = validToken

        // For "any post" automations, check all posts from this account
        if (!automation.postId) {
          console.log(`Processing "any post" automation ${automation._id}`)

          // Get all posts for this account
          const posts = await db.collection("posts").find({ instagramAccountId: instagramAccount._id }).toArray()

          console.log(`Found ${posts.length} posts for account ${instagramAccount._id}`)

          for (const post of posts) {
            await processPostComments(db, post, automation, instagramAccount, totalProcessed, totalSent)
          }

          continue
        }

        // Get the post
        const post = await db.collection("posts").findOne({
          _id: automation.postId,
        })

        if (!post) {
          console.log(`Post ${automation.postId} not found for automation ${automation._id}`)
          continue
        }

        await processPostComments(db, post, automation, instagramAccount, totalProcessed, totalSent)
      } catch (error) {
        console.error(`Error processing automation ${automation._id}:`, error)
      }
    }

    console.log(`Processed ${totalProcessed} comments, sent ${totalSent} messages`)

    return {
      success: true,
      automationsProcessed: automations.length,
      commentsProcessed: totalProcessed,
      messagesSent: totalSent,
    }
  } catch (error) {
    console.error("Error checking comments:", error)
    return { error: "Failed to check comments" }
  } finally {
    await client.close()
    console.log("Closed MongoDB connection")
  }
}

async function processPostComments(db, post, automation, instagramAccount, totalProcessed, totalSent) {
  try {
    // Get the last check time
    const lastChecked = automation.lastChecked || new Date(0)

    // Get comments since last check
    const comments = await getPostComments(instagramAccount.accessToken, post.instagramId, lastChecked.toISOString())

    console.log(`Found ${comments.length} new comments for post ${post.instagramId}`)

    totalProcessed += comments.length

    // Process each comment
    for (const comment of comments) {
      // Check if the comment contains the trigger keyword
      const triggerMatched =
        automation.triggerKeyword === "any" ||
        comment.text.toLowerCase().includes(automation.triggerKeyword.toLowerCase())

      if (!triggerMatched) {
        continue
      }

      console.log(`Trigger "${automation.triggerKeyword}" matched in comment from ${comment.username}`)

      // Check if we've already sent a DM to this user for this automation
      const existingDM = await db.collection("directMessages").findOne({
        automationId: automation._id,
        recipientUsername: comment.username,
      })

      if (existingDM) {
        console.log(`Already sent a DM to ${comment.username} for automation ${automation._id}`)
        continue
      }

      // Check rate limiting
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      const recentDMs = await db.collection("directMessages").countDocuments({
        automationId: automation._id,
        sentAt: { $gte: oneHourAgo },
        status: "sent",
      })

      if (recentDMs >= (automation.rateLimit || 10)) {
        console.log(`Rate limit reached for automation ${automation._id}`)
        continue
      }

      // Reply to the comment if enabled
      if (automation.replyToComments) {
        try {
          await replyToComment(
            instagramAccount.accessToken,
            comment.id,
            automation.commentReply || "Thanks! Please check your DMs.",
          )

          console.log(`Replied to comment ${comment.id}`)

          // Log the comment reply
          await db.collection("commentReplies").insertOne({
            _id: new ObjectId().toString(),
            automationId: automation._id,
            commentId: comment.id,
            username: comment.username,
            reply: automation.commentReply,
            status: "sent",
            sentAt: new Date(),
          })
        } catch (error) {
          console.error(`Error replying to comment ${comment.id}:`, error)
        }
      }

      // Send the DM
      try {
        if (automation.useOpeningMessage) {
          // Send opening message with button
          const openingMessage =
            automation.openingMessage ||
            "Hey there! I'm so happy you're here, thanks so much for your interest 😊\n\nClick below and I'll send you the link in just a sec ✨"

          const buttonText = automation.buttonText || "Send me the link"

          await sendDirectMessageWithButton(
            instagramAccount.accessToken,
            instagramAccount.instagramId,
            comment.username,
            openingMessage,
            buttonText,
            automation._id,
          )

          // Log the sent opening DM
          await db.collection("directMessages").insertOne({
            _id: new ObjectId().toString(),
            automationId: automation._id,
            recipientUsername: comment.username,
            commentId: comment.id,
            message: openingMessage,
            type: "opening",
            status: "sent",
            sentAt: new Date(),
          })
        } else {
          // Send direct message
          let fullMessage = automation.message

          if (automation.addBranding) {
            fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
          }

          await sendDirectMessage(
            instagramAccount.accessToken,
            instagramAccount.instagramId,
            comment.username,
            fullMessage,
          )

          // Log the sent DM
          await db.collection("directMessages").insertOne({
            _id: new ObjectId().toString(),
            automationId: automation._id,
            recipientUsername: comment.username,
            commentId: comment.id,
            message: fullMessage,
            type: "direct",
            status: "sent",
            sentAt: new Date(),
          })
        }

        totalSent++

        // Update automation stats
        await db.collection("automations").updateOne(
          { _id: automation._id },
          {
            $inc: { totalDMsSent: 1 },
            $set: { lastTriggered: new Date() },
          },
        )

        console.log(`Sent DM to ${comment.username} for automation ${automation._id}`)
      } catch (error) {
        console.error(`Error sending DM to ${comment.username}:`, error)

        // Log the failed DM
        await db.collection("directMessages").insertOne({
          _id: new ObjectId().toString(),
          automationId: automation._id,
          recipientUsername: comment.username,
          commentId: comment.id,
          message: automation.useOpeningMessage ? automation.openingMessage : automation.message,
          status: "failed",
          error: String(error),
          sentAt: new Date(),
        })
      }
    }

    // Update the last checked time
    await db.collection("automations").updateOne({ _id: automation._id }, { $set: { lastChecked: new Date() } })
  } catch (error) {
    console.error(`Error processing post comments:`, error)
  }
}

async function getPostComments(accessToken, postId, since) {
  try {
    const url = `https://graph.facebook.com/v18.0/${postId}/comments?fields=id,text,username,timestamp&access_token=${accessToken}&limit=50${since ? `&since=${since}` : ""}`

    const response = await fetch(url)

    if (!response.ok) {
      const errorData = await response.json()
      console.error("Instagram API error:", errorData)
      throw new Error(`Failed to fetch post comments: ${errorData.error?.message || response.statusText}`)
    }

    const data = await response.json()

    return data.data.map((comment) => ({
      id: comment.id,
      text: comment.text,
      username: comment.username || comment.from?.username,
      timestamp: comment.timestamp,
    }))
  } catch (error) {
    console.error("Error fetching post comments:", error)
    return []
  }
}

async function replyToComment(accessToken, commentId, replyText) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${commentId}/replies?message=${encodeURIComponent(replyText)}&access_token=${accessToken}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(`Failed to reply to comment: ${errorData.error?.message || response.statusText}`)
    }

    return await response.json()
  } catch (error) {
    console.error("Error replying to comment:", error)
    throw error
  }
}

async function sendDirectMessageWithButton(
  accessToken,
  instagramAccountId,
  recipientUsername,
  message,
  buttonText,
  automationId,
) {
  try {
    // First, we need to get the user ID from the username
    const userSearchResponse = await fetch(
      `https://graph.facebook.com/v18.0/ig_username_search?q=${recipientUsername}&access_token=${accessToken}`,
    )

    if (!userSearchResponse.ok) {
      const errorData = await userSearchResponse.json()
      throw new Error(`Failed to find Instagram user: ${errorData.error?.message || userSearchResponse.statusText}`)
    }

    const userSearchData = await userSearchResponse.json()

    if (!userSearchData.data || userSearchData.data.length === 0) {
      throw new Error(`Instagram user @${recipientUsername} not found`)
    }

    const recipientId = userSearchData.data[0].id

    // Now send the DM with button using the Instagram Graph API
    const dmResponse = await fetch(`https://graph.facebook.com/v18.0/${instagramAccountId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          text: message,
          quick_replies: [
            {
              content_type: "text",
              title: buttonText,
              payload: `SEND_CONTENT_${automationId}`,
            },
          ],
        },
        access_token: accessToken,
      }),
    })

    if (!dmResponse.ok) {
      const errorData = await dmResponse.json()
      throw new Error(`Failed to send direct message: ${errorData.error?.message || dmResponse.statusText}`)
    }

    return await dmResponse.json()
  } catch (error) {
    console.error("Error sending direct message with button:", error)
    throw error
  }
}

async function sendDirectMessage(accessToken, instagramAccountId, recipientUsername, message) {
  try {
    // First, we need to get the user ID from the username
    const userSearchResponse = await fetch(
      `https://graph.facebook.com/v18.0/ig_username_search?q=${recipientUsername}&access_token=${accessToken}`,
    )

    if (!userSearchResponse.ok) {
      const errorData = await userSearchResponse.json()
      throw new Error(`Failed to find Instagram user: ${errorData.error?.message || userSearchResponse.statusText}`)
    }

    const userSearchData = await userSearchResponse.json()

    if (!userSearchData.data || userSearchData.data.length === 0) {
      throw new Error(`Instagram user @${recipientUsername} not found`)
    }

    const recipientId = userSearchData.data[0].id

    // Now send the DM using the Instagram Graph API
    const dmResponse = await fetch(`https://graph.facebook.com/v18.0/${instagramAccountId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
        access_token: accessToken,
      }),
    })

    if (!dmResponse.ok) {
      const errorData = await dmResponse.json()
      throw new Error(`Failed to send direct message: ${errorData.error?.message || dmResponse.statusText}`)
    }

    return await dmResponse.json()
  } catch (error) {
    console.error("Error sending direct message:", error)
    throw error
  }
}

// Run the cron job
checkComments()
  .then((result) => {
    console.log("Cron job completed:", result)
    process.exit(0)
  })
  .catch((error) => {
    console.error("Cron job failed:", error)
    process.exit(1)
  })
