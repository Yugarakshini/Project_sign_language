// Global variables
let socket;
let currentRoom = null;
let mediaStream = null;
let recognition = null;

// DOM Elements
const elements = {
    homeScreen: document.getElementById('homeScreen'),
    roomScreen: document.getElementById('roomScreen'),
    localVideo: document.getElementById('localVideo'),
    roomVideo: document.getElementById('roomVideo'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    joinRoomBtn: document.getElementById('joinRoomBtn'),
    leaveRoomBtn: document.getElementById('leaveRoomBtn'),
    roomCodeInput: document.getElementById('roomCodeInput'),
    roomCodeDisplay: document.getElementById('roomCodeDisplay'),
    transcriptArea: document.getElementById('transcriptArea'),
    roomTranscriptArea: document.getElementById('roomTranscriptArea'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    mediaError: document.getElementById('mediaError'),
    notificationArea: document.getElementById('notificationArea'),
    userCount: document.getElementById('userCount')
};

// Initialize Socket.IO
function initializeSocket() {
    try {
        // Try to connect to the server using the current hostname
        const protocol = window.location.protocol;
        const host = window.location.hostname;
        const port = '8000';
        const serverUrl = `${protocol}//${host}:${port}`;
        
        socket = io(serverUrl, {
            transports: ['websocket', 'polling'],
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });

        // Update network status elements
        const serverStatus = document.getElementById('serverStatus');
        const networkInfo = document.getElementById('networkInfo');
        const networkUrl = document.getElementById('networkUrl');

        socket.on('connect', () => {
            console.log('Connected to server');
            serverStatus.textContent = 'Connected';
            serverStatus.className = 'text-green-600';
            showNotification('Connected to server', 'success');

            // Get server IP from health endpoint
            fetch('/health')
                .then(response => response.json())
                .then(data => {
                    if (data.serverIP && data.serverIP !== 'localhost') {
                        networkInfo.classList.remove('hidden');
                        networkUrl.textContent = `http://${data.serverIP}:8000`;
                    }
                })
                .catch(error => console.error('Failed to get network info:', error));
        });

        socket.on('connect_error', (error) => {
            console.error('Socket connection error:', error);
            serverStatus.textContent = 'Connection Error';
            serverStatus.className = 'text-red-600';
            showNotification('Connection error: ' + error.message, 'error');
        });

        socket.on('disconnect', () => {
            console.log('Disconnected from server');
            serverStatus.textContent = 'Disconnected';
            serverStatus.className = 'text-red-600';
            networkInfo.classList.add('hidden');
            showNotification('Disconnected from server', 'error');
        });

        socket.on('userJoined', ({ userId }) => {
            console.log('User joined:', userId);
            showNotification('New user joined the room', 'info');
            updateUserCount(1);
        });

        socket.on('userLeft', ({ userId }) => {
            console.log('User left:', userId);
            showNotification('A user left the room', 'info');
            updateUserCount(-1);
        });

        socket.on('receiveTranscript', ({ userId, text, timestamp }) => {
            console.log('Received transcript:', { userId, text, timestamp });
            addTranscriptMessage(text, 'Other', timestamp);
        });
    } catch (error) {
        console.error('Socket initialization error:', error);
        showNotification('Failed to initialize connection', 'error');
    }
}

// Media handling
async function initializeMedia() {
    try {
        showLoading(true);
        
        // Check if mediaDevices API is supported
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Media devices API is not supported in this browser');
        }

        // First try to get both video and audio
        try {
            const constraints = {
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user'
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true
                }
            };

            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            showNotification('Camera and microphone access granted', 'success');
        } catch (mediaError) {
            // If full access fails, try audio only
            console.warn('Full media access failed, trying audio only:', mediaError);
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: false,
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true
                    }
                });
                showNotification('Audio-only mode activated (no camera access)', 'info');
            } catch (audioError) {
                // If audio-only fails, continue without media devices
                console.warn('Audio-only access failed:', audioError);
                showNotification('Operating in text-only mode', 'info');
            }
        }

        // Update UI based on available media
        if (mediaStream) {
            if (mediaStream.getVideoTracks().length > 0) {
                elements.localVideo.srcObject = mediaStream;
                elements.roomVideo.srcObject = mediaStream;
                elements.mediaError.classList.add('hidden');
                
                // Wait for video to be ready
                await Promise.race([
                    new Promise(resolve => elements.localVideo.onloadedmetadata = resolve),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Video load timeout')), 5000))
                ]);
            } else {
                // Show audio-only message in video container
                elements.mediaError.classList.remove('hidden');
                elements.mediaError.innerHTML = `
                    <div class="text-center p-4">
                        <i class="fas fa-microphone text-4xl mb-2"></i>
                        <p class="text-lg">Audio-Only Mode</p>
                        <p class="text-sm mt-2">Camera access not available</p>
                    </div>
                `;
            }

            // Initialize speech recognition if we have audio
            if (mediaStream.getAudioTracks().length > 0) {
                initializeSpeechRecognition();
            }
        } else {
            // Show text-only mode message
            elements.mediaError.classList.remove('hidden');
            elements.mediaError.innerHTML = `
                <div class="text-center p-4">
                    <i class="fas fa-comment-alt text-4xl mb-2"></i>
                    <p class="text-lg">Text-Only Mode</p>
                    <p class="text-sm mt-2">Media access not available</p>
                </div>
            `;
        }
    } catch (error) {
        console.error('Media initialization error:', error);
        elements.mediaError.classList.remove('hidden');
        elements.mediaError.innerHTML = `
            <div class="text-center p-4">
                <i class="fas fa-exclamation-triangle text-4xl mb-2"></i>
                <p class="text-lg">${error.message || 'Failed to initialize media'}</p>
                <p class="text-sm mt-2">The application will continue in text-only mode</p>
            </div>
        `;
        showNotification('Continuing in text-only mode', 'info');
    } finally {
        showLoading(false);
    }
}

// Speech Recognition
function initializeSpeechRecognition() {
    try {
        // Check for various implementations of Speech Recognition API
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            throw new Error('Speech recognition is not supported in this browser');
        }

        recognition = new SpeechRecognition();
        
        // Optimize for better recognition
        recognition.continuous = false; // Process one utterance at a time
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.maxAlternatives = 3; // Get multiple alternatives
        
        // Lower confidence threshold for better sensitivity
        const confidenceThreshold = 0.6;
        
        // Add visual feedback for voice detection
        const videoContainer = document.querySelector('.video-container');
        const voiceIndicator = document.createElement('div');
        voiceIndicator.className = 'voice-indicator hidden';
        voiceIndicator.innerHTML = '<i class="fas fa-microphone text-green-500 text-xl"></i>';
        videoContainer.appendChild(voiceIndicator);

        recognition.onstart = () => {
            showNotification('Voice recognition active - Speak clearly', 'info');
            voiceIndicator.classList.remove('hidden');
        };

        recognition.onend = () => {
            // Automatically restart recognition after a short delay
            if (currentRoom) {
                setTimeout(() => {
                    try {
                        recognition.start();
                    } catch (error) {
                        console.warn('Failed to restart recognition:', error);
                    }
                }, 1000);
            }
            voiceIndicator.classList.add('hidden');
        };

        recognition.onaudiostart = () => {
            voiceIndicator.classList.add('pulse');
        };

        recognition.onaudioend = () => {
            voiceIndicator.classList.remove('pulse');
        };

        recognition.onresult = (event) => {
            let bestTranscript = '';
            let bestConfidence = 0;

            // Check all alternatives for the best confidence
            for (let i = event.results.length - 1; i >= 0; i--) {
                const result = event.results[i];
                if (result.isFinal) {
                    for (let j = 0; j < result.length; j++) {
                        const alternative = result[j];
                        if (alternative.confidence > bestConfidence) {
                            bestConfidence = alternative.confidence;
                            bestTranscript = alternative.transcript;
                        }
                    }
                    
                    // Use the best alternative if it meets the threshold
                    if (bestConfidence >= confidenceThreshold) {
                        const text = bestTranscript.trim();
                        if (text) {
                            addTranscriptMessage(text, 'You');
                            
                            if (currentRoom) {
                                socket.emit('sendTranscript', {
                                    roomId: currentRoom,
                                    text: text,
                                    confidence: bestConfidence
                                });
                            }
                        }
                    }
                    break;
                }
            }
        };

        // Add speech detection pause/resume
        let isListening = true;
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
                e.preventDefault();
                if (isListening) {
                    recognition.stop();
                    showNotification('Speech recognition paused (Press Space to resume)', 'info');
                } else {
                    recognition.start();
                    showNotification('Speech recognition resumed', 'info');
                }
                isListening = !isListening;
            }
        });

        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            let errorMessage = 'Speech recognition error';
            
            switch (event.error) {
                case 'network':
                    errorMessage = 'Network error occurred. Please check your connection.';
                    break;
                case 'not-allowed':
                    errorMessage = 'Microphone access denied. Please check permissions.';
                    break;
                case 'no-speech':
                    errorMessage = 'No speech detected. Please try again.';
                    break;
                default:
                    errorMessage = `Speech recognition error: ${event.error}`;
            }
            
            showNotification(errorMessage, 'error');
        };

        recognition.onend = () => {
            // Attempt to restart recognition if it ends unexpectedly
            if (currentRoom) {
                recognition.start();
            }
        };

        recognition.start();
    } catch (error) {
        console.error('Speech recognition initialization error:', error);
        showNotification(error.message, 'error');
    }
}

// Room Management
async function createRoom() {
    try {
        showLoading(true);
        
        // Check if socket is connected
        if (!socket || !socket.connected) {
            throw new Error('Not connected to server');
        }

        // Create room with Promise wrapper for better error handling
        await new Promise((resolve, reject) => {
            socket.emit('createRoom', (response) => {
                if (response.success) {
                    currentRoom = response.roomId;
                    elements.roomCodeDisplay.textContent = currentRoom;
                    switchToRoomScreen();
                    showNotification('Room created successfully', 'success');
                    resolve();
                } else {
                    reject(new Error(response.error || 'Failed to create room'));
                }
            });

            // Add timeout for room creation
            setTimeout(() => {
                reject(new Error('Room creation timeout'));
            }, 5000);
        });
    } catch (error) {
        console.error('Room creation error:', error);
        showNotification(error.message, 'error');
    } finally {
        showLoading(false);
    }
}


async function joinRoom() {
    const roomId = elements.roomCodeInput.value.trim();
    if (!roomId) {
        showNotification('Please enter a room code', 'error');
        return;
    }

    try {
        showLoading(true);
        socket.emit('joinRoom', roomId, (response) => {
            if (response.success) {
                currentRoom = roomId;
                elements.roomCodeDisplay.textContent = currentRoom;
                switchToRoomScreen();
                showNotification('Joined room successfully', 'success');
            } else {
                showNotification('Failed to join room: ' + response.error, 'error');
            }
            showLoading(false);
        });
    } catch (error) {
        showNotification('Error joining room', 'error');
        showLoading(false);
    }
}

function leaveRoom() {
    if (currentRoom) {
        socket.emit('leaveRoom', currentRoom);
        currentRoom = null;
        switchToHomeScreen();
        showNotification('Left the room', 'info');
    }
}

// UI Helpers
function switchToRoomScreen() {
    elements.homeScreen.classList.add('hidden');
    elements.roomScreen.classList.remove('hidden');
}

function switchToHomeScreen() {
    elements.homeScreen.classList.remove('hidden');
    elements.roomScreen.classList.add('hidden');
    elements.roomTranscriptArea.innerHTML = '';
    elements.userCount.textContent = '1';
}

function addTranscriptMessage(text, sender, timestamp = new Date().toISOString()) {
    const messageElement = document.createElement('div');
    messageElement.className = `transcript-message ${sender === 'You' ? 'self' : 'other'}`;
    
    const time = new Date(timestamp).toLocaleTimeString();
    const icon = sender === 'You' ? 'fa-user' : 'fa-user-friends';
    
    messageElement.innerHTML = `
        <div class="flex justify-between items-start mb-1">
            <div class="flex items-center">
                <i class="fas ${icon} text-gray-500 mr-2"></i>
                <span class="font-medium text-sm">${sender}</span>
            </div>
            <span class="text-xs text-gray-500">${time}</span>
        </div>
        <p class="text-gray-800 break-words">${text}</p>
    `;

    const targetArea = currentRoom ? elements.roomTranscriptArea : elements.transcriptArea;
    targetArea.appendChild(messageElement);
    
    // Smooth scroll to bottom
    targetArea.scrollTo({
        top: targetArea.scrollHeight,
        behavior: 'smooth'
    });
    
    // Remove old messages if there are too many (keep last 50)
    const messages = targetArea.getElementsByClassName('transcript-message');
    while (messages.length > 50) {
        messages[0].remove();
    }
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    const bgColor = {
        success: 'bg-green-500',
        error: 'bg-red-500',
        info: 'bg-blue-500'
    }[type];

    const icon = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        info: 'fa-info-circle'
    }[type];

    notification.className = `notification ${bgColor} text-white px-6 py-3 rounded-lg shadow-lg flex items-center space-x-3`;
    notification.innerHTML = `
        <i class="fas ${icon}"></i>
        <span>${message}</span>
    `;

    elements.notificationArea.appendChild(notification);
    
    // Fade out and remove after delay
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 300);
    }, 3000);

    // Remove old notifications if there are too many (keep last 3)
    const notifications = elements.notificationArea.getElementsByClassName('notification');
    while (notifications.length > 3) {
        notifications[0].remove();
    }
}

function showLoading(show) {
    elements.loadingOverlay.classList.toggle('hidden', !show);
}

function updateUserCount(change) {
    const currentCount = parseInt(elements.userCount.textContent);
    elements.userCount.textContent = currentCount + change;
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    initializeSocket();
    initializeMedia();

    elements.createRoomBtn.addEventListener('click', createRoom);
    elements.joinRoomBtn.addEventListener('click', joinRoom);
    elements.leaveRoomBtn.addEventListener('click', leaveRoom);
    
    // Speech test functionality
    const testSpeechBtn = document.getElementById('testSpeechBtn');
    const speechTestResult = document.getElementById('speechTestResult');
    const speechTestStatus = document.getElementById('speechTestStatus');
    const confidenceBar = document.getElementById('confidenceBar');
    
    let testRecognition = null;
    
    testSpeechBtn.addEventListener('click', () => {
        if (testRecognition) {
            testRecognition.stop();
            testSpeechBtn.innerHTML = '<i class="fas fa-microphone mr-2"></i><span>Test Microphone</span>';
            testSpeechBtn.classList.remove('bg-red-600', 'hover:bg-red-700');
            testSpeechBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
            return;
        }

        try {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            testRecognition = new SpeechRecognition();
            testRecognition.continuous = false;
            testRecognition.interimResults = true;
            testRecognition.maxAlternatives = 3;
            testRecognition.lang = 'en-US';

            speechTestResult.classList.remove('hidden');
            speechTestStatus.textContent = 'Listening... Speak a test phrase';
            testSpeechBtn.innerHTML = '<i class="fas fa-stop-circle mr-2"></i><span>Stop Test</span>';
            testSpeechBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
            testSpeechBtn.classList.add('bg-red-600', 'hover:bg-red-700');

            testRecognition.onresult = (event) => {
                let bestConfidence = 0;
                let bestTranscript = '';

                for (let i = event.results.length - 1; i >= 0; i--) {
                    const result = event.results[i];
                    if (result.isFinal) {
                        for (let j = 0; j < result.length; j++) {
                            const alternative = result[j];
                            if (alternative.confidence > bestConfidence) {
                                bestConfidence = alternative.confidence;
                                bestTranscript = alternative.transcript;
                            }
                        }
                        
                        const confidencePercent = Math.round(bestConfidence * 100);
                        confidenceBar.style.width = `${confidencePercent}%`;
                        
                        if (confidencePercent >= 80) {
                            confidenceBar.classList.remove('bg-yellow-500', 'bg-red-500');
                            confidenceBar.classList.add('bg-green-500');
                        } else if (confidencePercent >= 60) {
                            confidenceBar.classList.remove('bg-green-500', 'bg-red-500');
                            confidenceBar.classList.add('bg-yellow-500');
                        } else {
                            confidenceBar.classList.remove('bg-green-500', 'bg-yellow-500');
                            confidenceBar.classList.add('bg-red-500');
                        }

                        speechTestStatus.innerHTML = `
                            <div class="space-y-2">
                                <p>Recognition Quality: ${confidencePercent}%</p>
                                <p class="text-sm text-gray-600">Recognized Text: "${bestTranscript}"</p>
                            </div>
                        `;
                    }
                }
            };

            const errorMessage = document.getElementById('errorMessage');
            const errorDetails = document.getElementById('errorDetails');
            const permissionInstructions = document.getElementById('permissionInstructions');

            testRecognition.onerror = (event) => {
                speechTestResult.classList.add('hidden');
                errorMessage.classList.remove('hidden');
                permissionInstructions.classList.remove('hidden');

                switch (event.error) {
                    case 'not-allowed':
                        errorDetails.textContent = 'Microphone access was denied. Please allow access to use voice recognition.';
                        break;
                    case 'no-speech':
                        errorDetails.textContent = 'No speech was detected. Please try speaking again.';
                        break;
                    case 'network':
                        errorDetails.textContent = 'Network error occurred. Please check your internet connection.';
                        break;
                    default:
                        errorDetails.textContent = `Error: ${event.error}. Please try again.`;
                }
                stopTest();
            };

            testRecognition.onstart = () => {
                errorMessage.classList.add('hidden');
                speechTestResult.classList.remove('hidden');
                speechTestStatus.textContent = 'Listening... Speak a test phrase';
                testSpeechBtn.innerHTML = '<i class="fas fa-stop-circle mr-2"></i><span>Stop Test</span>';
                testSpeechBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
                testSpeechBtn.classList.add('bg-red-600', 'hover:bg-red-700');
            };

            testRecognition.onend = () => {
                stopTest();
            };

            testRecognition.start();
        } catch (error) {
            speechTestStatus.innerHTML = `
                <div class="text-red-600">
                    <p>Speech recognition not supported</p>
                    <p class="text-sm">Please use a modern browser like Chrome</p>
                </div>
            `;
            speechTestResult.classList.remove('hidden');
        }
    });

    function stopTest() {
        if (testRecognition) {
            testRecognition.stop();
            testRecognition = null;
        }
        testSpeechBtn.innerHTML = '<i class="fas fa-microphone mr-2"></i><span>Test Microphone</span>';
        testSpeechBtn.classList.remove('bg-red-600', 'hover:bg-red-700');
        testSpeechBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
    }
    
    elements.roomCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinRoom();
    });
});

// Handle page unload
window.addEventListener('beforeunload', () => {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
    if (recognition) {
        recognition.stop();
    }
    if (currentRoom) {
        socket.emit('leaveRoom', currentRoom);
    }
});
