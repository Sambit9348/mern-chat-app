const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const getUserDetailsFromToken = require('../helpers/getUserDetailsFromToken');
const UserModel = require('../models/UserModel');
const { ConversationModel, MessageModel } = require('../models/ConversationModel');
const getConversation = require('../helpers/getConversation');

const app = express();

// Create HTTP server
const server = http.createServer(app);

// Initialize socket.io with CORS
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        credentials: true
    }
});

// Online users
const onlineUsers = new Set();

// Socket connection
io.on('connection', async (socket) => {
    console.log('Connected user:', socket.id);

    const token = socket.handshake.auth.token;

    if (!token) {
        socket.emit('error', 'Token is required');
        return;
    }

    try {
        // Get user details
        const user = await getUserDetailsFromToken(token);
        if (!user) {
            socket.emit('error', 'Authentication failed');
            return;
        }

        socket.join(user._id.toString());
        onlineUsers.add(user._id.toString());
        io.emit('onlineUser', Array.from(onlineUsers));

        // Message Page Handler
        socket.on('message-page', async (userId) => {
            try {
                const userDetails = await UserModel.findById(userId).select('-password');
                const payload = {
                    _id: userDetails._id,
                    name: userDetails.name,
                    email: userDetails.email,
                    profile_pic: userDetails.profile_pic,
                    online: onlineUsers.has(userId)
                };
                socket.emit('message-user', payload);

                const getConversationMessage = await ConversationModel.findOne({
                    $or: [
                        { sender: user._id, receiver: userId },
                        { sender: userId, receiver: user._id }
                    ]
                }).populate('messages').sort({ updatedAt: -1 });

                socket.emit('message', getConversationMessage?.messages || []);
            } catch (err) {
                socket.emit('error', 'Error fetching message-page data: ' + err.message);
            }
        });

        // New Message Handler
        socket.on('new message', async (data) => {
            try {
                let conversation = await ConversationModel.findOne({
                    $or: [
                        { sender: data.sender, receiver: data.receiver },
                        { sender: data.receiver, receiver: data.sender }
                    ]
                });

                if (!conversation) {
                    const newConversation = new ConversationModel({
                        sender: data.sender,
                        receiver: data.receiver
                    });
                    conversation = await newConversation.save();
                }

                const message = new MessageModel({
                    text: data.text,
                    imageUrl: data.imageUrl,
                    videoUrl: data.videoUrl,
                    msgByUserId: data.msgByUserId
                });
                const saveMessage = await message.save();

                await ConversationModel.updateOne({ _id: conversation._id }, {
                    $push: { messages: saveMessage._id }
                });

                const updatedConversation = await ConversationModel.findOne({
                    $or: [
                        { sender: data.sender, receiver: data.receiver },
                        { sender: data.receiver, receiver: data.sender }
                    ]
                }).populate('messages').sort({ updatedAt: -1 });

                io.to(data.sender).emit('message', updatedConversation?.messages || []);
                io.to(data.receiver).emit('message', updatedConversation?.messages || []);

                const conversationSender = await getConversation(data.sender);
                const conversationReceiver = await getConversation(data.receiver);

                io.to(data.sender).emit('conversation', conversationSender);
                io.to(data.receiver).emit('conversation', conversationReceiver);
            } catch (err) {
                socket.emit('error', 'Error handling new message: ' + err.message);
            }
        });

        // Sidebar Handler
        socket.on('sidebar', async (currentUserId) => {
            try {
                const conversations = await getConversation(currentUserId);
                socket.emit('conversation', conversations);
            } catch (err) {
                socket.emit('error', 'Error fetching sidebar data: ' + err.message);
            }
        });

        // Seen Handler
        socket.on('seen', async (msgByUserId) => {
            try {
                const conversation = await ConversationModel.findOne({
                    $or: [
                        { sender: user._id, receiver: msgByUserId },
                        { sender: msgByUserId, receiver: user._id }
                    ]
                });

                const conversationMessageIds = conversation?.messages || [];
                await MessageModel.updateMany(
                    { _id: { $in: conversationMessageIds }, msgByUserId },
                    { $set: { seen: true } }
                );

                const conversationSender = await getConversation(user._id.toString());
                const conversationReceiver = await getConversation(msgByUserId);

                io.to(user._id.toString()).emit('conversation', conversationSender);
                io.to(msgByUserId).emit('conversation', conversationReceiver);
            } catch (err) {
                socket.emit('error', 'Error handling seen: ' + err.message);
            }
        });

        // Disconnect Handler
        socket.on('disconnect', () => {
            onlineUsers.delete(user._id.toString());
            console.log('Disconnected user:', socket.id);
        });

    } catch (err) {
        console.error('Socket connection error:', err.message);
    }
});

module.exports = {
    app,
    server
};
