import { OPENAI_API_KEY, GOOGLE_API_KEY } from './config.js';
import { initDB, saveAudioToDB, fetchAllRecordings } from './index-db.js';
import { 
    startAudioVisualizer, 
    stopAudioVisualizer, 
    startVAD, 
    stopVAD, 
    displayClientSideTopics 
} from './stt-kit.js';

document.addEventListener('DOMContentLoaded', () => {
    
    const firebaseConfig = {
      apiKey: "AIzaSyCjVuc2VD5YvJE_4PBUJATmKiJzFC1ex8c",
      authDomain: "aitek2023-8f504.firebaseapp.com",
      databaseURL: "https://aitek2023-8f504-default-rtdb.firebaseio.com",
      projectId: "aitek2023-8f504",
      storageBucket: "aitek2023-8f504.appspot.com",
      messagingSenderId: "570516064142",
      appId: "1:570516064142:web:383ef4de00b5f48f5886df",
      measurementId: "G-PFSD6YN1TV"
    };
    firebase.initializeApp(firebaseConfig);
    const storage = firebase.storage();
    const storageRef = storage.ref();

    const MAX_CHUNK_DURATION_SECONDS_OPENAI = 100;
    const MEDIA_RECORDER_TIMESLICE_MS = 3000;

    let audioContext;
    let mediaRecorder;
    let allRecordedBlobs = []; 
    let currentStream = null; 

    let vadContext = {
        recordingState: 'idle',
        VAD_SILENCE_THRESHOLD: 0.01,
        VAD_MIN_SPEECH_DURATION_MS: 200,
        vadIsSpeaking: false,
        vadSpeechStartTime: 0,
        activeSpeechSegments: []
    };

    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingMessage = document.getElementById('loadingMessage');
    const themeToggleCheckbox = document.getElementById('themeToggleCheckbox');
    const statusDisplayText = document.getElementById('statusDisplayText');
    const startRecordBtn = document.getElementById('startRecordBtn');
    const pauseRecordBtn = document.getElementById('pauseRecordBtn');
    const resumeRecordBtn = document.getElementById('resumeRecordBtn');
    const stopRecordBtn = document.getElementById('stopRecordBtn');
    const sttServiceSelect = document.getElementById('sttServiceSelect');
    const transcriptOutputConvo = document.getElementById('transcriptOutputConvo');
    const transcriptOutputMultispeaker = document.getElementById('transcriptOutputMultispeaker');
    const detectedTopicsList = document.getElementById('detectedTopicsList'); 
    const topicMedicalCheckbox = document.getElementById('topicMedical');
    const topicGeneralCheckbox = document.getElementById('topicGeneral');
    const uploadAudioBtn = document.getElementById('uploadAudioBtn');
    const audioFileUpload = document.getElementById('audioFileUpload');
    const fileNameDisplay = document.getElementById('fileNameDisplay');
    const visualizerCanvas = document.getElementById('audioVisualizerCanvas');
    const recordedAudioList = document.getElementById('recordedAudioList');

    initDB().then(() => {
        loadAndRenderRecordedAudio();
    }).catch(err => console.error("Failed to initialize IndexedDB:", err));

    document.getElementById('currentYear').textContent = new Date().getFullYear();

    function showLoading(context = "Processing") { 
        if (context === "recording_start") return;
        let message;
        switch (context) {
            case "mic_request": message = "Requesting microphone..."; break;
            case "finalizing_recording": message = "Finalizing audio..."; break;
            case "decoding": message = "Decoding audio..."; break;
            case "uploading_prepare": message = "Preparing upload..."; break;
            case "uploading_to_firebase": message = "Saving to cloud..."; break;
            case "transcribing_chunk": message = "Transcribing..."; break; 
            case "finalizing_transcription": message = "Finalizing transcript..."; break;
            case "google_upload_start": message = "Google API: Initiating upload..."; break;
            case "google_upload_finalize": message = "Google API: Uploading audio..."; break;
            case "google_gemini_generate": message = "Google API: Analyzing audio..."; break;
            default: message = "Processing..."; break;
        }
        loadingMessage.textContent = message;
        loadingOverlay.classList.add('visible');
    }

    function hideLoading() { 
        loadingOverlay.classList.remove('visible');
    }

    function applyTheme(theme) { 
        if (theme === 'dark') {
            document.body.classList.add('dark-theme');
            themeToggleCheckbox.checked = true;
        } else {
            document.body.classList.remove('dark-theme');
            themeToggleCheckbox.checked = false;
        }
    }

    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) applyTheme(savedTheme);
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark');
    else applyTheme('light'); 

    themeToggleCheckbox.addEventListener('change', function() {
        const theme = this.checked ? 'dark' : 'light';
        applyTheme(theme);
        localStorage.setItem('theme', theme);
    });

    function updateUIForRecordingState() { 
        const recordingState = vadContext.recordingState;
        startRecordBtn.disabled = recordingState !== 'idle';
        pauseRecordBtn.disabled = recordingState !== 'recording';
        resumeRecordBtn.disabled = recordingState !== 'paused';
        stopRecordBtn.disabled = recordingState === 'idle' || recordingState === 'requesting';
        uploadAudioBtn.disabled = recordingState !== 'idle';
        sttServiceSelect.disabled = recordingState !== 'idle';
        topicMedicalCheckbox.disabled = recordingState !== 'idle';
        topicGeneralCheckbox.disabled = recordingState !== 'idle';
        [startRecordBtn, pauseRecordBtn, resumeRecordBtn, stopRecordBtn, uploadAudioBtn].forEach(btn => {
            btn.classList.toggle('disabled', btn.disabled);
        });
    }

    function updateStatus(message, type = "info") { 
        statusDisplayText.textContent = message;
        statusDisplayText.className = 'status-display-text';
        if (type === "error") statusDisplayText.classList.add('error');
        if (type === "success") statusDisplayText.classList.add('success');
        if (type === "error") console.error(`UI Status (Error): ${message}`);
        else console.log(`UI Status: ${message} (Type: ${type})`);
    }

    function clearOutputFields() { 
        transcriptOutputConvo.value = "";
        transcriptOutputMultispeaker.value = "";
        detectedTopicsList.innerHTML = '<li>No topics detected yet.</li>';
        detectedTopicsList.classList.add('empty');
    }
    
    function resetToIdle(message = "Idle. Ready to record or upload.", type = "info") { 
        vadContext.recordingState = 'idle';
        updateUIForRecordingState();
        updateStatus(message, type);
        fileNameDisplay.textContent = "No file selected.";
        if(audioFileUpload.value) audioFileUpload.value = '';
        allRecordedBlobs = []; 
        vadContext.activeSpeechSegments = []; 
        vadContext.vadIsSpeaking = false; 
        vadContext.vadSpeechStartTime = 0;

        stopAudioVisualizer(visualizerCanvas); 
        visualizerCanvas.style.display = 'none';

        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
            currentStream = null;
        }
        mediaRecorder = null;
        hideLoading();
        startRecordBtn.textContent = "Start Recording";
        startRecordBtn.classList.remove('animating');
        pauseRecordBtn.textContent = "Pause";
        resumeRecordBtn.textContent = "Resume";
        stopRecordBtn.textContent = "Stop & Transcribe";
        stopRecordBtn.classList.remove('animating');
        uploadAudioBtn.textContent = "Upload Audio File";
        uploadAudioBtn.classList.remove('animating');
        updateUIForRecordingState();
    }
   
    async function uploadAudioToFirebase(blob, firebasePathWithName) { 
        const audioRef = storageRef.child(firebasePathWithName);
        updateStatus(`Saving "${firebasePathWithName.split('/').pop()}" to cloud storage...`, "info");
        try {
            const snapshot = await audioRef.put(blob);
            const downloadURL = await snapshot.ref.getDownloadURL();
            console.log(`Uploaded "${firebasePathWithName}" to Firebase Storage: ${downloadURL}`);
            updateStatus(`Audio saved to cloud: ${firebasePathWithName.split('/').pop()}`, "success");
            return downloadURL;
        } catch (error) {
            console.error("Error uploading to Firebase Storage:", error);
            updateStatus(`Error saving to cloud: ${error.message.substring(0,100)}`, "error");
            throw error; 
        }
    }
            
    startRecordBtn.addEventListener('click', async () => { 
        const selectedService = sttServiceSelect.value;
        if (selectedService === 'openai_whisper' && (!OPENAI_API_KEY || OPENAI_API_KEY.includes("YOUR_OPENAI_API_KEY"))) {
            updateStatus("OpenAI API Key not configured. Please check js/config.js", "error"); return;
        }
        if (selectedService === 'google_gemini_audio' && (!GOOGLE_API_KEY || GOOGLE_API_KEY.includes("YOUR_GOOGLE_GENERATIVE_LANGUAGE_API_KEY_HERE"))) {
            updateStatus("Google API Key not configured. Please check js/config.js", "error"); return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { 
            updateStatus("Microphone access not supported by your browser.", "error"); return; 
        }
        clearOutputFields(); 
        vadContext.activeSpeechSegments = [];
        updateStatus("Requesting microphone access...", "info"); 
        showLoading("mic_request");
        vadContext.recordingState = 'requesting'; 
        updateUIForRecordingState();
        startRecordBtn.textContent = "Requesting mic...";
        try {
            currentStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            hideLoading(); 
            vadContext.recordingState = 'recording'; 
            updateStatus("Recording...", "info"); 
            updateUIForRecordingState();
            startRecordBtn.textContent = "Recording..."; 
            startRecordBtn.classList.add('animating');
            startAudioVisualizer(currentStream, visualizerCanvas);
            startVAD(currentStream, vadContext);

            allRecordedBlobs = []; 
            let options = { mimeType: 'audio/webm;codecs=opus' }; 
            if (!MediaRecorder.isTypeSupported(options.mimeType)) { 
                options.mimeType = 'audio/webm';
                if (!MediaRecorder.isTypeSupported(options.mimeType)) options = {};
            }
            mediaRecorder = new MediaRecorder(currentStream, options);
            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) allRecordedBlobs.push(event.data);
            };
            mediaRecorder.onstop = async () => {
                stopVAD(vadContext);
                startRecordBtn.classList.remove('animating');
                stopRecordBtn.classList.remove('animating');
                if (vadContext.recordingState !== 'stopped_for_processing') { 
                    vadContext.recordingState = 'stopped_for_processing'; 
                    updateStatus("Recording stopped. Processing audio...", "info");
                    showLoading("finalizing_recording"); 
                }
                stopAudioVisualizer(visualizerCanvas);
                visualizerCanvas.style.display = 'none';
                if (allRecordedBlobs.length > 0) {
                    const completeOriginalBlob = new Blob(allRecordedBlobs, { type: allRecordedBlobs[0].type || 'audio/webm' });
                    allRecordedBlobs = [];
                    const timestamp = new Date().toISOString();
                    const recordingNameBase = `recording-${timestamp.replace(/[:.]/g, '-')}`;
                    const localRecordingName = `${recordingNameBase}.webm`;
                    const firebaseRecordingPath = `recorded_audio/${localRecordingName}`;
                    await saveAudioToDB(completeOriginalBlob, localRecordingName).then(loadAndRenderRecordedAudio);
                    try {
                        showLoading("uploading_to_firebase"); 
                        await uploadAudioToFirebase(completeOriginalBlob, firebaseRecordingPath);
                    } catch (fbError) {
                        console.warn("Firebase upload failed but continuing with transcription:", fbError);
                        updateStatus("Cloud save failed, proceeding locally.", "info");
                    } finally {
                        hideLoading(); 
                    }
                    if (vadContext.activeSpeechSegments.length === 0 && completeOriginalBlob.size > 0) {
                        updateStatus("No distinct speech segments detected by VAD, transcribing full audio.", "info");
                    }
                    await processAndTranscribeAudio(completeOriginalBlob, localRecordingName);
                } else { 
                    resetToIdle("No audio data recorded.", "info"); 
                }
                if (currentStream) { 
                   currentStream.getTracks().forEach(track => track.stop());
                   currentStream = null;
                }
                updateUIForRecordingState();
            };
            mediaRecorder.onerror = (event) => { 
                console.error("MediaRecorder error:", event.error);
                resetToIdle(`Recorder error: ${event.error.name}. Check console.`, "error"); 
                stopVAD(vadContext);
                startRecordBtn.classList.remove('animating'); 
                hideLoading();
            };
            mediaRecorder.start(MEDIA_RECORDER_TIMESLICE_MS);
        } catch (err) { 
            console.error("Microphone access error:", err);
            let msg = `Mic access error: ${err.name} - ${err.message}.`;
            if (err.name === "NotAllowedError") msg = "Mic permission denied. Please allow access.";
            if (err.name === "NotFoundError") msg = "No microphone found.";
            resetToIdle(msg, "error"); 
            stopVAD(vadContext);
            startRecordBtn.classList.remove('animating'); 
            hideLoading(); 
        }
    });

    pauseRecordBtn.addEventListener('click', () => { 
        if (mediaRecorder && mediaRecorder.state === "recording") { 
            mediaRecorder.pause(); 
            vadContext.recordingState = 'paused'; 
            updateStatus("Recording paused.", "info"); 
            updateUIForRecordingState(); 
            startRecordBtn.textContent = "Paused"; 
            startRecordBtn.classList.remove('animating');
            stopAudioVisualizer(visualizerCanvas);
            visualizerCanvas.style.display = 'none';
        }
    });

    resumeRecordBtn.addEventListener('click', () => { 
        if (mediaRecorder && mediaRecorder.state === "paused") { 
            mediaRecorder.resume(); 
            vadContext.recordingState = 'recording'; 
            updateStatus("Recording resumed...", "info"); 
            updateUIForRecordingState(); 
            startRecordBtn.textContent = "Recording..."; 
            startRecordBtn.classList.add('animating');
            if (currentStream) {
                startAudioVisualizer(currentStream, visualizerCanvas);
            }
        }
    });

    stopRecordBtn.addEventListener('click', () => { 
        if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
            vadContext.recordingState = 'stopped_for_processing';
            updateUIForRecordingState(); 
            startRecordBtn.classList.remove('animating'); 
            stopRecordBtn.textContent = "Finalizing..."; 
            stopRecordBtn.classList.add('animating');
            showLoading("finalizing_recording"); 
            mediaRecorder.stop();
        } else { 
            resetToIdle("Not actively recording or already stopped.", "info"); 
        }
    });

    uploadAudioBtn.addEventListener('click', () => { 
        const selectedService = sttServiceSelect.value;
        if (selectedService === 'openai_whisper' && (!OPENAI_API_KEY || OPENAI_API_KEY.includes("YOUR_OPENAI_API_KEY"))) {
            updateStatus("OpenAI API Key not configured. Please check js/config.js", "error"); return;
        }
        if (selectedService === 'google_gemini_audio' && (!GOOGLE_API_KEY || GOOGLE_API_KEY.includes("YOUR_GOOGLE_GENERATIVE_LANGUAGE_API_KEY_HERE"))) {
            updateStatus("Google API Key not configured. Please check js/config.js", "error"); return;
        }
        if (vadContext.recordingState !== 'idle') { 
            updateStatus("Please stop any current recording process first.", "info"); return; 
        } 
        audioFileUpload.click(); 
    });

    audioFileUpload.addEventListener('change', async (event) => { 
        const file = event.target.files[0];
        if (file) {
            fileNameDisplay.textContent = `Selected: ${file.name}`;
            clearOutputFields();
            updateStatus(`Preparing "${file.name}"...`, "info");
            showLoading("uploading_prepare"); 
            uploadAudioBtn.textContent = "Processing..."; 
            uploadAudioBtn.classList.add('animating'); 
            
            const originalFileName = file.name;
            const firebaseUploadedFilePath = `uploaded_audio/${originalFileName}`;

            await saveAudioToDB(file, originalFileName).then(loadAndRenderRecordedAudio);
            try {
                showLoading("uploading_to_firebase"); 
                await uploadAudioToFirebase(file, firebaseUploadedFilePath);
            } catch (fbError) {
                 console.warn("Firebase upload failed for uploaded file, continuing locally:", fbError);
                 updateStatus("Cloud save failed for upload, proceeding locally.", "info");
            } finally {
                hideLoading();
            }
            await processAndTranscribeAudio(file, originalFileName);
        } else { 
            fileNameDisplay.textContent = "No file selected."; 
            uploadAudioBtn.textContent = "Upload Audio File";
            uploadAudioBtn.classList.remove('animating');
        }
        event.target.value = null;
        updateUIForRecordingState();
    });

    async function loadAndRenderRecordedAudio() {
        recordedAudioList.innerHTML = '';
        const recordings = await fetchAllRecordings();

        if (recordings.length === 0) {
            recordedAudioList.innerHTML = '<li class="empty-list-message">No recordings yet. View the <a href="transcription-list.html">full history</a>.</li>';
            return;
        }
        
        recordings.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        recordings.forEach(record => {
            const listItem = document.createElement('li');
            const audioUrl = URL.createObjectURL(record.blob);
            listItem.innerHTML = `
                <p><strong>${record.name}</strong></p>
                <p class="audio-metadata">Recorded: ${new Date(record.timestamp).toLocaleString()} | Size: ${(record.blob.size / (1024 * 1024)).toFixed(2)} MB</p>
                <audio controls src="${audioUrl}"></audio>
            `;
            recordedAudioList.appendChild(listItem);
        });
    }

    async function processAndTranscribeAudio(inputAudioBlob, originalFileName) {
        if (!loadingOverlay.classList.contains('visible')) {
            showLoading("transcribing_chunk"); 
        }
        const targetButtonForAnimation = vadContext.recordingState === 'stopped_for_processing' ? stopRecordBtn : uploadAudioBtn;
        targetButtonForAnimation.textContent = "Transcribing...";
        targetButtonForAnimation.classList.add('animating');
        const selectedSttService = sttServiceSelect.value;

        if (selectedSttService === 'openai_whisper') {
            await transcribeWithOpenAI(inputAudioBlob, originalFileName);
        } else if (selectedSttService === 'google_gemini_audio') {
            await transcribeWithGoogleGemini(inputAudioBlob, originalFileName);
        } else {
            resetToIdle("Invalid STT service selected.", "error");
        }
        targetButtonForAnimation.classList.remove('animating');
    }

    async function transcribeWithOpenAI(inputAudioBlob, originalFileName) {
        let decodedAudioBuffer;
        try {
            showLoading("decoding");
            updateStatus(`Decoding "${originalFileName}" for OpenAI...`, "info");
            const arrayBuffer = await inputAudioBlob.arrayBuffer();
            if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (audioContext.state === 'suspended') await audioContext.resume();
            decodedAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        } catch (e) {
            console.error("Error decoding audio for OpenAI:", e);
            resetToIdle(`Error decoding audio: ${e.message.substring(0,100)}`, "error"); return;
        }

        const totalDuration = decodedAudioBuffer.duration;
        if (totalDuration <= 0 || !isFinite(totalDuration)) {
            resetToIdle("Audio duration is invalid or zero for OpenAI.", "error"); return;
        }

        const numChunks = Math.ceil(totalDuration / MAX_CHUNK_DURATION_SECONDS_OPENAI);
        let allTranscribedText = ""; 
        let allSegmentsForMultispeaker = [];

        for (let i = 0; i < numChunks; i++) {
            showLoading("transcribing_chunk"); 
            updateStatus(`OpenAI: Transcribing chunk ${i + 1} of ${numChunks}...`, "info");
            const chunkStartTimeAbsolute = i * MAX_CHUNK_DURATION_SECONDS_OPENAI;
            const chunkEndTimeAbsolute = Math.min((i + 1) * MAX_CHUNK_DURATION_SECONDS_OPENAI, totalDuration);
            const chunkDuration = chunkEndTimeAbsolute - chunkStartTimeAbsolute;
            if (chunkDuration <= 0.1) continue;
            const startSample = Math.floor(chunkStartTimeAbsolute * decodedAudioBuffer.sampleRate);
            const endSample = Math.ceil(chunkEndTimeAbsolute * decodedAudioBuffer.sampleRate);
            const chunkNumSamples = endSample - startSample;
            if (chunkNumSamples <= 0) continue;
            const chunkAudioBuffer = audioContext.createBuffer(decodedAudioBuffer.numberOfChannels, chunkNumSamples, decodedAudioBuffer.sampleRate);
            for (let channel = 0; channel < decodedAudioBuffer.numberOfChannels; channel++) {
                chunkAudioBuffer.getChannelData(channel).set(decodedAudioBuffer.getChannelData(channel).slice(startSample, endSample));
            }
            const wavBlob = bufferToWave(chunkAudioBuffer, chunkNumSamples);
            const formData = new FormData();
            formData.append("file", wavBlob, `chunk_${i+1}.wav`); 
            formData.append("model", "whisper-1");
            formData.append("response_format", "verbose_json");
            formData.append("timestamp_granularities[]", "segment"); 

            try {
                const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { 
                    method: "POST", headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }, body: formData 
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error ? data.error.message : `HTTP error! status: ${response.status}`);
                if (data.text) allTranscribedText += data.text + " "; 
                if (data.segments) {
                    data.segments.forEach(seg => allSegmentsForMultispeaker.push({ ...seg, start: seg.start + chunkStartTimeAbsolute, end: seg.end + chunkStartTimeAbsolute }));
                }
            } catch (error) { 
                console.error(`Error processing OpenAI chunk ${i + 1}:`, error); 
                allTranscribedText += `[ERROR IN OPENAI CHUNK ${i+1}: ${error.message.substring(0,50)}] `;
            }
        } 
        showLoading("finalizing_transcription");
        transcriptOutputConvo.value = allTranscribedText.trim();
        let multispeakerOutput = "";
        allSegmentsForMultispeaker.sort((a,b) => a.start - b.start).forEach(seg => { 
            multispeakerOutput += `[${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s] ${seg.text}\n`; 
        });
        transcriptOutputMultispeaker.value = multispeakerOutput.trim() + "\n\n(Note: OpenAI Whisper provides time segments but not speaker labels.)";
        displayClientSideTopics(allTranscribedText, topicMedicalCheckbox, topicGeneralCheckbox, detectedTopicsList);
        if (allTranscribedText.includes("[ERROR IN OPENAI CHUNK")) { 
            resetToIdle(`OpenAI transcription partially failed. Check console.`, "error"); 
        } else if (allTranscribedText.trim() === "") { 
            resetToIdle(`OpenAI: No speech detected or no text for "${originalFileName}".`, "info"); 
        } else { 
            resetToIdle(`OpenAI transcription of "${originalFileName}" complete!`, "success"); 
        }
    }
            
    async function transcribeWithGoogleGemini(inputAudioBlob, originalFileName) {
        try {
            showLoading("google_upload_start");
            updateStatus(`Google Gemini: Initiating upload for "${originalFileName}"...`, "info");
            const uploadStartResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GOOGLE_API_KEY}`, {
                method: 'POST',
                headers: {
                    'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
                    'X-Goog-Upload-Header-Content-Length': String(inputAudioBlob.size), 
                    'X-Goog-Upload-Header-Content-Type': inputAudioBlob.type, 'Content-Type': 'application/json'
                },
                body: JSON.stringify({ file: { display_name: originalFileName } })
            });
            if (!uploadStartResponse.ok) throw new Error(await uploadStartResponse.text());
            const uploadUrl = uploadStartResponse.headers.get('X-Goog-Upload-Url');
            
            showLoading("google_upload_finalize");
            updateStatus(`Google Gemini: Uploading audio "${originalFileName}"...`, "info");
            const uploadFinalizeResponse = await fetch(uploadUrl, {
                method: 'POST',
                headers: { 'Content-Length': String(inputAudioBlob.size), 'X-Goog-Upload-Command': 'upload, finalize' },
                body: inputAudioBlob
            });
            if (!uploadFinalizeResponse.ok) throw new Error(await uploadFinalizeResponse.text());
            const fileInfo = await uploadFinalizeResponse.json();
            
            showLoading("google_gemini_generate");
            updateStatus(`Google Gemini: Analyzing and describing audio...`, "info");
            const generateContentResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GOOGLE_API_KEY}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [
                        { text: "Describe this audio clip in detail, and if any speech is present, transcribe it as accurately as possible. Summarize key points if it's a conversation." }, 
                        { file_data: { mime_type: inputAudioBlob.type, file_uri: fileInfo.file.uri } }
                    ] }]
                })
            });
            if (!generateContentResponse.ok) throw new Error(await generateContentResponse.text());
            const geminiData = await generateContentResponse.json();
            const geminiDescription = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "No description found.";
            transcriptOutputConvo.value = geminiDescription;
            transcriptOutputMultispeaker.value = "(Google Gemini 2.0 Flash: Audio Description does not provide speaker labels or time segments.)";
            displayClientSideTopics(geminiDescription, topicMedicalCheckbox, topicGeneralCheckbox, detectedTopicsList);
            resetToIdle(`Google Gemini audio description of "${originalFileName}" complete!`, "success");
        } catch (error) {
            console.error('Error with Google Gemini:', error);
            resetToIdle(`Google Gemini API Error: ${error.message.substring(0,200)}`, "error");
        }
    }

    function bufferToWave(audioBuffer, len) { 
        let numOfChan = audioBuffer.numberOfChannels, length = len * numOfChan * 2 + 44, 
            buffer = new ArrayBuffer(length), view = new DataView(buffer), 
            channels = [], i, sample, offset = 0, pos = 0;
        function writeString(v, o, s) { for (let k=0; k<s.length; k++) v.setUint8(o+k, s.charCodeAt(k)); }
        writeString(view, pos, 'RIFF'); pos+=4;
        view.setUint32(pos, length - 8, true); pos+=4;
        writeString(view, pos, 'WAVE'); pos+=4;
        writeString(view, pos, 'fmt '); pos+=4;
        view.setUint32(pos, 16, true); pos+=4;
        view.setUint16(pos, 1, true); pos+=2;
        view.setUint16(pos, numOfChan, true); pos+=2;
        view.setUint32(pos, audioBuffer.sampleRate, true); pos+=4;
        view.setUint32(pos, audioBuffer.sampleRate * 2 * numOfChan, true); pos+=4;
        view.setUint16(pos, numOfChan * 2, true); pos+=2;
        view.setUint16(pos, 16, true); pos+=2;
        writeString(view, pos, 'data'); pos+=4;
        view.setUint32(pos, length - pos - 4, true); pos+=4;
        for (i = 0; i < audioBuffer.numberOfChannels; i++) channels.push(audioBuffer.getChannelData(i));
        while (pos < length) {
            for (i = 0; i < numOfChan; i++) {             
                sample = Math.max(-1, Math.min(1, channels[i][offset]));
                sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF);
                view.setInt16(pos, sample, true);          
                pos += 2;
            }
            offset++;                                     
        }
        return new Blob([view], { type: 'audio/wav' });
    }
    resetToIdle(); 
});
