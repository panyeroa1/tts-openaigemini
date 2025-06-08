import { DynamoDBClient } from "https://js.aws.amazon.com/v3/latest/client/dynamodb/index.js";
import { DynamoDBDocumentClient, ScanCommand } from "https://js.aws.amazon.com/v3/latest/lib/lib-dynamodb/index.js";
import { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DYNAMODB_TABLE_NAME } from "./aws-config.js";

// --- DynamoDB Functions ---

/**
 * Fetches all transcription records from the configured DynamoDB table.
 * @returns {Promise<Array<Object>>} A promise that resolves with an array of cloud transcription items.
 */
export async function fetchTranscriptions() {
    if (AWS_ACCESS_KEY_ID === "YOUR_AWS_ACCESS_KEY_ID" || AWS_SECRET_ACCESS_KEY === "YOUR_AWS_SECRET_ACCESS_KEY") {
        console.warn("AWS credentials are placeholders. Skipping cloud fetch.");
        return [];
    }

    const client = new DynamoDBClient({
        region: AWS_REGION,
        credentials: {
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY
        }
    });

    const docClient = DynamoDBDocumentClient.from(client);

    try {
        const command = new ScanCommand({ TableName: DYNAMODB_TABLE_NAME });
        const response = await docClient.send(command);
        const items = response.Items || [];
        const cloudItems = items.map(item => ({...item, source: 'cloud'}));
        cloudItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        console.log(`Fetched ${cloudItems.length} items from DynamoDB.`);
        return cloudItems;
    } catch (error) {
        console.error("Error fetching from DynamoDB:", error);
        const listContainer = document.getElementById('transcriptionList');
        if(listContainer) {
            const errorLi = document.createElement('li');
            errorLi.className = 'empty-list-message';
            errorLi.style.color = 'var(--error-color)';
            errorLi.textContent = `Could not load cloud records. Check credentials and permissions.`;
            listContainer.appendChild(errorLi);
        }
        return [];
    }
}

/**
 * Renders a list of merged (local & cloud) transcription items into a container.
 * @param {Array<Object>} items The array of items to render.
 * @param {HTMLElement} container The `<ul>` element to render into.
 */
export function renderTranscriptionList(items, container) {
    container.innerHTML = '';

    if (items.length === 0) {
        container.innerHTML = '<li class="empty-list-message">No local or cloud recordings found.</li>';
        return;
    }

    items.forEach(item => {
        const listItem = document.createElement('li');
        const timestamp = new Date(item.timestamp).toLocaleString();
        
        let audioElement = '';
        if (item.source === 'local' && item.blob) {
            const audioUrl = URL.createObjectURL(item.blob);
            audioElement = `<audio controls src="${audioUrl}"></audio>`;
        } else if (item.source === 'cloud' && item.audioUrl) {
            audioElement = `<audio controls src="${item.audioUrl}"></audio>`;
        }

        let transcriptLink = '';
        if (item.transcriptUrl) {
             transcriptLink = `<a href="${item.transcriptUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="width: auto; padding: 0.5em 1em; text-decoration: none;">View Transcript</a>`;
        }

        listItem.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem;">
                <div>
                    <p><strong>${item.name || item.id}</strong></p>
                    <p class="audio-metadata">
                        Recorded: ${timestamp} | Source: 
                        <span style="font-weight: 600; color: ${item.source === 'cloud' ? 'var(--finla-green-accent)' : 'var(--finla-light-blue-accent)'};">
                            ${item.source.charAt(0).toUpperCase() + item.source.slice(1)}
                        </span>
                    </p>
                </div>
                ${transcriptLink}
            </div>
            ${audioElement}
        `;
        container.appendChild(listItem);
    });
}

// --- Helper Functions (Visualizer, VAD, Topics) ---
let audioContext;
let mediaStreamSourceForVisualizer, analyserNode, animationFrameId, dataArray;
let mediaStreamSourceForVAD, vadAnalyserNode, vadProcessorNode;

export function startAudioVisualizer(stream, canvas) { 
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    
    mediaStreamSourceForVisualizer = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256; 
    const bufferLength = analyserNode.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    
    mediaStreamSourceForVisualizer.connect(analyserNode);
    canvas.style.display = 'block';
    
    const ctx = canvas.getContext('2d');
    drawAudioVisualizer(canvas, ctx, analyserNode, dataArray);
}

function drawAudioVisualizer(canvas, ctx, analyser, localDataArray) { 
    if (!analyser || !mediaStreamSourceForVisualizer || !mediaStreamSourceForVisualizer.mediaStream.active) { 
        return;
    }
    animationFrameId = requestAnimationFrame(() => drawAudioVisualizer(canvas, ctx, analyser, localDataArray)); 
    analyser.getByteFrequencyData(localDataArray); 

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--output-bg').trim();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const bufferLength = analyser.frequencyBinCount;
    const barWidth = (canvas.width / bufferLength) * 1.25;
    let barHeight;
    let x = 0;

    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
    const accentSecondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-secondary').trim();

    for (let i = 0; i < bufferLength; i++) {
        barHeight = localDataArray[i];
        const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - (barHeight / 2));
        gradient.addColorStop(0, accentColor);
        gradient.addColorStop(1, accentSecondaryColor);
        ctx.fillStyle = gradient;
        const scaledHeight = (barHeight / 255) * canvas.height;
        ctx.fillRect(x, canvas.height - scaledHeight, barWidth, scaledHeight);
        x += barWidth + 1;
    }
}

export function stopAudioVisualizer(canvas) { 
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (mediaStreamSourceForVisualizer) { try { mediaStreamSourceForVisualizer.disconnect(); } catch(e) {} }
    if (analyserNode) { try { analyserNode.disconnect(); } catch(e) {} }
}

export function startVAD(stream, context) { 
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();

    mediaStreamSourceForVAD = audioContext.createMediaStreamSource(stream);
    vadAnalyserNode = audioContext.createAnalyser();
    vadAnalyserNode.fftSize = 512; 
    vadAnalyserNode.smoothingTimeConstant = 0.5; 

    if (typeof audioContext.createScriptProcessor !== 'function') {
        console.warn("audioContext.createScriptProcessor is deprecated. VAD will not run.");
        return; 
    }

    const bufferSize = vadAnalyserNode.fftSize;
    vadProcessorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
    const vadDataArray = new Uint8Array(vadAnalyserNode.frequencyBinCount);

    vadProcessorNode.onaudioprocess = function() {
        if (context.recordingState !== 'recording' || !vadProcessorNode) return; 

        vadAnalyserNode.getByteFrequencyData(vadDataArray);
        let sum = 0;
        for (let i = 0; i < vadDataArray.length; i++) sum += vadDataArray[i];
        const averageEnergy = sum / vadDataArray.length / 255;
        const currentTime = audioContext.currentTime; 

        if (averageEnergy > context.VAD_SILENCE_THRESHOLD) { 
            if (!context.vadIsSpeaking) { 
                context.vadIsSpeaking = true;
                context.vadSpeechStartTime = currentTime;
            }
        } else { 
            if (context.vadIsSpeaking) { 
                if ((currentTime - context.vadSpeechStartTime) * 1000 >= context.VAD_MIN_SPEECH_DURATION_MS) {
                    context.activeSpeechSegments.push({ start: context.vadSpeechStartTime, end: currentTime });
                }
                context.vadIsSpeaking = false;
                context.vadSpeechStartTime = 0; 
            }
        }
    };
    mediaStreamSourceForVAD.connect(vadAnalyserNode);
    vadAnalyserNode.connect(vadProcessorNode);
    vadProcessorNode.connect(audioContext.destination);
    console.log("VAD System Initialized & Started");
}

export function stopVAD(context) { 
    if (context.vadIsSpeaking && context.vadSpeechStartTime > 0 && audioContext && audioContext.currentTime) { 
         const currentTime = audioContext.currentTime;
         if(currentTime > context.vadSpeechStartTime && (currentTime - context.vadSpeechStartTime) * 1000 >= context.VAD_MIN_SPEECH_DURATION_MS) {
            context.activeSpeechSegments.push({ start: context.vadSpeechStartTime, end: currentTime });
         }
    }
    context.vadIsSpeaking = false;
    context.vadSpeechStartTime = 0;
    if (mediaStreamSourceForVAD) { try { mediaStreamSourceForVAD.disconnect(); } catch(e){} }
    if (vadAnalyserNode) { try { vadAnalyserNode.disconnect(); } catch(e){} }
    if (vadProcessorNode) { 
        try { vadProcessorNode.disconnect(); } catch(e){}
        vadProcessorNode.onaudioprocess = null;
    } 
    console.log("VAD System Stopped.");
}

export function displayClientSideTopics(text, topicMedicalCheckbox, topicGeneralCheckbox, detectedTopicsList) { 
    const TOPIC_KEYWORDS_LOCAL = { 
        medical: [
            'doctor', 'clinic', 'hospital', 'polyclinic', 'singhealth', 'nuhs', 'healthhub', 'medisave', 'medishield', 
            'appointment', 'prescription', 'diagnosis', 'treatment', 'referral', 'medical certificate', 'mc', 
            'vaccination', 'health screening', 'physiotherapy', 'ward', 'icu', 'a&e', 'emergency', 'specialist',
            'general practitioner', 'gp', 'pharmacy', 'medication', 'symptom', 'illness', 'disease', 'insurance claim health',
            'integrated shield plan', 'careshield'
        ],
    };
    const detected = new Set();
    const lowerText = text.toLowerCase();
    if (topicMedicalCheckbox.checked) {
        for (const keyword of TOPIC_KEYWORDS_LOCAL.medical) {
            if (lowerText.includes(keyword.toLowerCase())) {
                detected.add("Medical (Singapore) - Keyword Match");
                break;
            }
        }
    }
    if (detected.size === 0 && topicGeneralCheckbox.checked) {
        detected.add("General - Keyword Match");
    }
    detectedTopicsList.innerHTML = '';
    if (detected.size > 0) {
        detectedTopicsList.classList.remove('empty');
        detected.forEach(topic => {
            const listItem = document.createElement('li');
            listItem.textContent = topic;
            detectedTopicsList.appendChild(listItem);
        });
    } else {
        detectedTopicsList.classList.add('empty');
        detectedTopicsList.innerHTML = '<li>No focused topics detected by client-side keywords.</li>';
    }
}
