
flowchart TD
    subgraph Offline_Environment[Fully Offline / Air-Gapped Environment]
        direction TD
        
        subgraph Tauri_App[Blacksite Node UI]
            direction TD
            User_Input([User Types Password])
            Display([Strength UI & Hex-Line Anim])
        end

        subgraph Core_Backend[Rust Tauri Backend]
            direction TD
            ML_Bridge[Python Subprocess Manager]
            Scorer_API[JSON Score Parser]
        end

        subgraph ML_Engine[Python ML Inference Engine]
            direction TD
            Hybrid_Scorer[Hybrid Pre-Check Scorer]
            Tokenizer[Character Tokenizer]
            ONNX_Runtime[ONNX Runtime CPU]
            NLL_Calc[NLL Calculator]
            Static_Weak[Static Score]
            Static_Div[Diversity Score]
            Result_JSON[Output JSON]
            
            subgraph Model_Artifacts[Exported Artifacts]
                direction TD
                Model_ONNX[(password_model.onnx)]
                Vocab[(vocab.json)]
                Meta[(dataset_meta.json)]
            end
        end
        
        %% Force Vertical Stacking of Subgraphs
        Tauri_App ~~~ Core_Backend
        Core_Backend ~~~ ML_Engine
        
        %% Connections
        User_Input -- "Raw String" --> ML_Bridge
        ML_Bridge -- "CLI Args" --> Hybrid_Scorer
        
        Hybrid_Scorer -- "Length < 6" --> Static_Weak
        Hybrid_Scorer -- "Length <= 10" --> Static_Div
        Hybrid_Scorer -- "Length > 10" --> Tokenizer
        
        Vocab -. "Mapping" .-> Tokenizer
        Tokenizer -- "Int Sequence" --> ONNX_Runtime
        Model_ONNX -. "Weights" .-> ONNX_Runtime
        
        ONNX_Runtime -- "Log-Likelihood Array" --> NLL_Calc
        
        Static_Weak --> Result_JSON
        Static_Div --> Result_JSON
        NLL_Calc -- "NLL & Label" --> Result_JSON
        
        Result_JSON -- "Stdout" --> Scorer_API
        Scorer_API -- "Rust Struct" --> Display
    end
    
    classDef secure fill:#0d1117,stroke:#FF5E5B,stroke-width:2px,color:#fff;
    classDef process fill:#21262d,stroke:#30363d,stroke-width:1px,color:#c9d1d9;
    classDef storage fill:#161b22,stroke:#FF5E5B,stroke-width:1px,color:#fff,stroke-dasharray: 5 5;
    
    class Offline_Environment secure;
    class ML_Bridge,Tokenizer,ONNX_Runtime,NLL_Calc,Hybrid_Scorer process;
    class Model_ONNX,Vocab,Meta storage;

