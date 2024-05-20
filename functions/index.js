import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./config/db.config.js";
import router from "./routes/index.routes.js";
import { onRequest, onCall } from "firebase-functions/v2/https";
import User, { User as UserSchema } from "./models/user.model.js";
import Campaign from "./models/campaign.model.js";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2";
import { auth } from "./config/firebaseAdmin.config.js";
import mongoose from "mongoose";

mongoose.model("User", UserSchema);

dotenv.config();

const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ensure modularity by abstracting away the database connection.
connectDB();

//https://ecobloom-rsxx5czyua-uc.a.run.app
app.get("/", (req, res) => {
    const message = "EcoBloom API at /";
    res.json(message);
});

//https://ecobloom-rsxx5czyua-uc.a.run.app/api
app.get("/api", (req, res) => {
    const message = "EcoBloom API at /api";
    res.json(message);
});

app.use("/api", router);

setGlobalOptions({ maxInstances: 10 });

export const ecobloom = onRequest({ cors: true }, app);

// custom claims is a feature of Firebase Authentication that allows you to add custom attributes to a user's ID token.
// useful for defining roles and permissions for our users.
// helps in defining the access control for our users.
export const setCustomClaims = onCall(async (data, context) => {
    try {
        // extract the role and firebaseId from the data object
        // role can be either "org", or "user", or "admin" (requires to be done manually for admin)
        const { role, firebaseId } = data.data;
        const uid = firebaseId;
        console.log("data: ", data.data);
        if (role === "user") {
            await auth.setCustomUserClaims(uid, {
                role: role,
                userId: firebaseId,
            });
        } else {
            await auth.setCustomUserClaims(uid, {
                role: role,
                orgId: firebaseId,
                isVerified: false,
            });
        }
        console.log("User from setCustomClaims: ", firebaseId);
    } catch (error) {
        console.error("Error setting custom claims:", error);
        throw new Error(error);
    }
});

// creating a cron-job (scheduled for every 10 minutes) for checking if any campaign got completed
// if the camapign is completed, then update all the verified user's points and activity log
export const checkCompletedCampaigns = onSchedule(
    "every 10 minutes",
    async (event) => {
        console.log("Event from scheduler: ", event);
        try {
            // Retrieve all campaigns from the database which are completed (i.e., endTime <= currTime)
            const campaigns = await Campaign.find({
                isCompleted: false,
                endDate: {
                    $lte: new Date().toISOString(),
                },
            }).populate("verifiedUsers");
            console.log("campaigns to update: ", campaigns);

            // Iterate through campaigns and check if any have reached their end date
            const userUpdations = {};

            // intelligently update the user's points and activity log
            /*
                it's basically going through all completed campaigns, and if a user was involved in
                multiple campaigns, then it will aggregate the points and update the user's points
                through simultaneous resolution of asynchronous promises.
            */
            campaigns.forEach(async (campaign) => {
                // If the current date is after the campaign's end date
                // Update the campaign's status to "Completed"
                campaign.isCompleted = true;
                console.log("updated " + campaign.name);
                if (campaign.verifiedUsersCount > 0) {
                    // Iterate through all the verified users of the campaign
                    campaign.verifiedUsers.forEach(async (user) => {
                        if (
                            !userUpdations[user._id] ||
                            Object.keys(userUpdations[user._id]).length === 0
                        ) {
                            userUpdations[user._id] = {
                                points: campaign.points,
                                completedCampaigns: [campaign._id],
                                activityLog: {
                                    content:
                                        `Congratulations on completing the campaign "${campaign.name}"! You have been awarded 🪙` +
                                        campaign.points +
                                        " points!",
                                    date: new Date(),
                                    type: "completedCampaign",
                                },
                            };
                        } else {
                            userUpdations[user._id].points += campaign.points;
                            userUpdations[user._id].completedCampaigns.push(
                                campaign._id
                            );
                        }
                    });
                }

                await campaign.save();
            });
            const userUpdationPromises = Object.keys(userUpdations).map(
                async (userId) => {
                    const user = await User.findById(userId);
                    user.points += userUpdations[userId].points;
                    user.completedCampaigns.push(
                        ...userUpdations[userId].completedCampaigns
                    );
                    await user.save();
                }
            );
            console.log("userUpdations: ", userUpdations);
            console.log("userUpdationPromises: ", userUpdationPromises);
            await Promise.all(userUpdationPromises);
        } catch (error) {
            console.error("Error in scheduled task:", error);
        }
    }
);
