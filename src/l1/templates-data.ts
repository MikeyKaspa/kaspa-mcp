/* Auto-generated — do not edit by hand. */
export const TEMPLATE_BUNDLES = [
  {
    "id": "tipjar",
    "source": "pragma silverscript ^0.1.0;\n\n// Anyone can fund this P2SH. Owner withdraws with matching pubkey + sig.\ncontract TipJar(byte[32] ownerPkh) {\n    entry withdraw(pubkey pk, sig s) {\n        require(blake2b(byte[](pk)) == ownerPkh);\n        require(checkSig(s, pk));\n    }\n}\n",
    "wrapped": {
      "meta": {
        "templateId": "tipjar",
        "silverc": "v1.0.0",
        "networkHint": "testnet-10",
        "demoPrivateKeyNote": "Demo-only sample (not for real funds). On your own copy the bot rebinds the template to your spending wallet automatically — no manual key compile step.",
        "demoAddress": "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd",
        "exampleP2shTestnet10": "kaspatest:prfqwa3gj2y245963eqg28ce34tce9qtxfc43guxvwlz9rd05xflg6ardagg2",
        "bytecodeLen": 69,
        "entries": {
          "withdraw": {
            "dispatch_tag": "e36d1915",
            "params": [
              {
                "name": "pk",
                "type": {
                  "kind": "pubkey"
                }
              },
              {
                "name": "s",
                "type": {
                  "kind": "sig"
                }
              }
            ]
          }
        },
        "recommendedEntry": "withdraw",
        "demoPkhHex": "9407263be9dc3c4b5b9afbd02ebb5d5cbda687dfb57c65c1816c8cdca9b677a0",
        "demoXOnlyPubHex": "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
      },
      "artifact": {
        "schema_version": 1,
        "compiler_version": "0.1.0",
        "structs": {},
        "contracts": {
          "TipJar": {
            "source_path": "sil/TipJar.sil",
            "runtime_state": {
              "source": "State",
              "fields": []
            },
            "entries": {
              "withdraw": {
                "dispatch_tag": "e36d1915",
                "params": [
                  {
                    "name": "pk",
                    "type": {
                      "kind": "pubkey"
                    }
                  },
                  {
                    "name": "s",
                    "type": {
                      "kind": "sig"
                    }
                  }
                ]
              }
            },
            "compiled": {
              "bytecode": [
                118,
                4,
                227,
                109,
                25,
                21,
                135,
                99,
                117,
                120,
                130,
                1,
                32,
                157,
                117,
                118,
                130,
                1,
                65,
                157,
                117,
                120,
                170,
                32,
                148,
                7,
                38,
                59,
                233,
                220,
                60,
                75,
                91,
                154,
                251,
                208,
                46,
                187,
                93,
                92,
                189,
                166,
                135,
                223,
                181,
                124,
                101,
                193,
                129,
                108,
                140,
                220,
                169,
                182,
                119,
                160,
                135,
                105,
                118,
                82,
                121,
                172,
                105,
                117,
                117,
                81,
                103,
                106,
                104
              ],
              "template_hash": [
                177,
                151,
                227,
                84,
                242,
                94,
                42,
                213,
                252,
                220,
                194,
                38,
                100,
                119,
                119,
                22,
                41,
                146,
                164,
                151,
                31,
                226,
                46,
                253,
                171,
                190,
                115,
                52,
                77,
                242,
                225,
                114
              ],
              "state_span": {
                "offset": 0,
                "len": 0
              }
            }
          }
        }
      }
    }
  },
  {
    "id": "timeout_vault",
    "source": "pragma silverscript ^0.1.0;\n\n// Recipient can take funds immediately; sender reclaims after timeout.\ncontract TimeoutVault(\n    pubkey sender,\n    pubkey recipient,\n    temporal timeout\n) {\n    entry transfer(sig recipientSig) {\n        require(checkSig(recipientSig, recipient));\n    }\n\n    entry timeout(sig senderSig) {\n        require(checkSig(senderSig, sender));\n        require(tx.time >= timeout);\n    }\n}\n",
    "wrapped": {
      "meta": {
        "templateId": "timeout_vault",
        "silverc": "v1.0.0",
        "networkHint": "testnet-10",
        "demoPrivateKeyNote": "Demo-only sample (not for real funds). On your own copy the bot rebinds the template to your spending wallet automatically — no manual key compile step.",
        "demoAddress": "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd",
        "exampleP2shTestnet10": "kaspatest:pzw2pu32alulge2gv0phjpavgyjlc9plj2vm94lf8vyav3jl9madu3x9qadk5",
        "bytecodeLen": 128,
        "entries": {
          "timeout": {
            "dispatch_tag": "bcce79af",
            "params": [
              {
                "name": "senderSig",
                "type": {
                  "kind": "sig"
                }
              }
            ]
          },
          "transfer": {
            "dispatch_tag": "de5ac30f",
            "params": [
              {
                "name": "recipientSig",
                "type": {
                  "kind": "sig"
                }
              }
            ]
          }
        },
        "recommendedEntry": "transfer",
        "timeoutMs": 4000000000000,
        "demoPkhHex": "9407263be9dc3c4b5b9afbd02ebb5d5cbda687dfb57c65c1816c8cdca9b677a0",
        "demoXOnlyPubHex": "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
      },
      "artifact": {
        "schema_version": 1,
        "compiler_version": "0.1.0",
        "structs": {},
        "contracts": {
          "TimeoutVault": {
            "source_path": "sil/TimeoutVault.sil",
            "runtime_state": {
              "source": "State",
              "fields": []
            },
            "entries": {
              "timeout": {
                "dispatch_tag": "bcce79af",
                "params": [
                  {
                    "name": "senderSig",
                    "type": {
                      "kind": "sig"
                    }
                  }
                ]
              },
              "transfer": {
                "dispatch_tag": "de5ac30f",
                "params": [
                  {
                    "name": "recipientSig",
                    "type": {
                      "kind": "sig"
                    }
                  }
                ]
              }
            },
            "compiled": {
              "bytecode": [
                118,
                4,
                222,
                90,
                195,
                15,
                135,
                99,
                117,
                118,
                130,
                1,
                65,
                157,
                117,
                118,
                32,
                121,
                190,
                102,
                126,
                249,
                220,
                187,
                172,
                85,
                160,
                98,
                149,
                206,
                135,
                11,
                7,
                2,
                155,
                252,
                219,
                45,
                206,
                40,
                217,
                89,
                242,
                129,
                91,
                22,
                248,
                23,
                152,
                172,
                105,
                117,
                81,
                103,
                118,
                4,
                188,
                206,
                121,
                175,
                135,
                99,
                117,
                118,
                130,
                1,
                65,
                157,
                117,
                118,
                32,
                121,
                190,
                102,
                126,
                249,
                220,
                187,
                172,
                85,
                160,
                98,
                149,
                206,
                135,
                11,
                7,
                2,
                155,
                252,
                219,
                45,
                206,
                40,
                217,
                89,
                242,
                129,
                91,
                22,
                248,
                23,
                152,
                172,
                105,
                6,
                0,
                64,
                148,
                82,
                163,
                3,
                118,
                5,
                0,
                136,
                82,
                106,
                116,
                162,
                105,
                176,
                117,
                81,
                103,
                106,
                104,
                104
              ],
              "template_hash": [
                2,
                5,
                211,
                173,
                176,
                29,
                84,
                128,
                104,
                229,
                187,
                132,
                125,
                12,
                13,
                186,
                21,
                114,
                196,
                44,
                180,
                55,
                218,
                231,
                42,
                159,
                219,
                5,
                29,
                165,
                65,
                87
              ],
              "state_span": {
                "offset": 0,
                "len": 0
              }
            }
          }
        }
      }
    }
  },
  {
    "id": "escrow",
    "source": "pragma silverscript ^0.1.0;\n\n// Arbiter (blake2b of their pubkey) can release funds to buyer OR seller.\n// minerFee is baked into the script — must match the spend's fee exactly.\ncontract Escrow(byte[32] arbiter, pubkey buyer, pubkey seller) {\n    entry spend(pubkey pk, sig s) {\n        require(blake2b(byte[](pk)) == arbiter);\n        require(checkSig(s, pk));\n\n        // 0.003 KAS — covers typical TN10 compute-mass fee for this script size.\n        int minerFee = 300000;\n        int amount = tx.inputs[this.activeInputIndex].value - minerFee;\n        require(tx.outputs[0].value == amount);\n\n        byte[36] buyerLock = new ScriptPubKeyP2PK(buyer);\n        byte[36] sellerLock = new ScriptPubKeyP2PK(seller);\n        bool sendsToBuyer = tx.outputs[0].scriptPubKey == byte[](buyerLock);\n        bool sendsToSeller = tx.outputs[0].scriptPubKey == byte[](sellerLock);\n        require(sendsToBuyer || sendsToSeller);\n    }\n}\n",
    "wrapped": {
      "meta": {
        "templateId": "escrow",
        "silverc": "v1.0.0",
        "networkHint": "testnet-10",
        "demoPrivateKeyNote": "Demo-only sample (not for real funds). On your own copy the bot rebinds the template to your spending wallet automatically — no manual key compile step.",
        "demoAddress": "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd",
        "exampleP2shTestnet10": "kaspatest:pq7efuqrnlk38q94jlrv4qqxhscuul500h7x73yfgzk5vcw2t6ytz09us4frv",
        "bytecodeLen": 184,
        "entries": {
          "spend": {
            "dispatch_tag": "514bee64",
            "params": [
              {
                "name": "pk",
                "type": {
                  "kind": "pubkey"
                }
              },
              {
                "name": "s",
                "type": {
                  "kind": "sig"
                }
              }
            ]
          }
        },
        "recommendedEntry": "spend",
        "escrowMinerFeeSompi": 300000,
        "demoPkhHex": "9407263be9dc3c4b5b9afbd02ebb5d5cbda687dfb57c65c1816c8cdca9b677a0",
        "demoXOnlyPubHex": "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
      },
      "artifact": {
        "schema_version": 1,
        "compiler_version": "0.1.0",
        "structs": {},
        "contracts": {
          "Escrow": {
            "source_path": "sil/Escrow.sil",
            "runtime_state": {
              "source": "State",
              "fields": []
            },
            "entries": {
              "spend": {
                "dispatch_tag": "514bee64",
                "params": [
                  {
                    "name": "pk",
                    "type": {
                      "kind": "pubkey"
                    }
                  },
                  {
                    "name": "s",
                    "type": {
                      "kind": "sig"
                    }
                  }
                ]
              }
            },
            "compiled": {
              "bytecode": [
                118,
                4,
                81,
                75,
                238,
                100,
                135,
                99,
                117,
                120,
                130,
                1,
                32,
                157,
                117,
                118,
                130,
                1,
                65,
                157,
                117,
                120,
                170,
                32,
                148,
                7,
                38,
                59,
                233,
                220,
                60,
                75,
                91,
                154,
                251,
                208,
                46,
                187,
                93,
                92,
                189,
                166,
                135,
                223,
                181,
                124,
                101,
                193,
                129,
                108,
                140,
                220,
                169,
                182,
                119,
                160,
                135,
                105,
                118,
                82,
                121,
                172,
                105,
                3,
                224,
                147,
                4,
                185,
                190,
                120,
                148,
                0,
                194,
                120,
                156,
                105,
                3,
                0,
                0,
                32,
                32,
                121,
                190,
                102,
                126,
                249,
                220,
                187,
                172,
                85,
                160,
                98,
                149,
                206,
                135,
                11,
                7,
                2,
                155,
                252,
                219,
                45,
                206,
                40,
                217,
                89,
                242,
                129,
                91,
                22,
                248,
                23,
                152,
                126,
                1,
                172,
                126,
                3,
                0,
                0,
                32,
                32,
                121,
                190,
                102,
                126,
                249,
                220,
                187,
                172,
                85,
                160,
                98,
                149,
                206,
                135,
                11,
                7,
                2,
                155,
                252,
                219,
                45,
                206,
                40,
                217,
                89,
                242,
                129,
                91,
                22,
                248,
                23,
                152,
                126,
                1,
                172,
                126,
                0,
                195,
                82,
                121,
                135,
                0,
                195,
                82,
                121,
                135,
                120,
                120,
                155,
                105,
                117,
                117,
                117,
                117,
                117,
                117,
                117,
                117,
                81,
                103,
                106,
                104
              ],
              "template_hash": [
                243,
                144,
                3,
                207,
                250,
                123,
                119,
                228,
                168,
                93,
                203,
                217,
                226,
                178,
                146,
                169,
                188,
                78,
                112,
                74,
                126,
                44,
                171,
                174,
                110,
                209,
                155,
                227,
                107,
                211,
                80,
                65
              ],
              "state_span": {
                "offset": 0,
                "len": 0
              }
            }
          }
        }
      }
    }
  }
] as const;
