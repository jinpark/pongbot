//  _____             _____     _
// |  _  |___ ___ ___| __  |___| |
// |   __| . |   | . | __ -| . |  _|
// |__|  |___|_|_|_  |_____|___|_|
//               |___|


// Version 0.9
//
// Right now, this is just a single monolithic file that I would like to split up into their own modules. It should be easy to abstract all the DB stuff and Pongbot Lib stuff into their own modules.
//
// In the next few versions, I would like to:
//
// - Update/tweak the elo algorithm and allow for placement matches
// - More helpful command syntax
// - An API for you guys to play around with, socket.io for live updates
// - Rankings
// - Matchmaking Service (Matches people up with similar skill levels.)

var express = require('express')
,   bodyParser = require('body-parser')
,   mongoose = require('mongoose')
,   pluralize = require('pluralize')
,   request = require('request')
,   moment = require('moment-timezone')
,   chalk = require('chalk')
,   rest = require('restler')
,   Schema = mongoose.Schema;

var app = express();

var TIMEZONE = 'America/New_York';

var mongoUri = process.env.MONGOLAB_URI ||
  process.env.MONGOHQ_URL ||
  'mongodb://localhost/pingpong';
mongoose.connect(mongoUri);


// POST to this URI with payload={"text": "STUFF GOES HERE"}
var slackUri = 'https://dramafever.slack.com/services/hooks/incoming-webhook?token=PgnzQtt2eHfnRHkcNwchp3A0';
var rfidServer = process.env.NODE_ENV == 'development' ? 
  'http://www.lvh.me:3000' : 'http://stormy-woodland-4323.herokuapp.com/' ;

app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

var PlayerSchema = new Schema({
  user_name: String,
  wins: Number,
  losses: Number,
  elo: Number,
  tau: Number,
  currentChallenge: { type: Schema.Types.ObjectId, ref: 'Challenge' },
  rfid: String,
  name: String,
  image: String,
  uri: String,
  gender: String,
  play_count: Number
});

var ChallengeSchema = new Schema({
  state: String,
  type: String,
  date: Date,
  challenger: Array,
  challenged: Array
});

var UnclaimedSchema = new Schema({
  tag: String
});

var Player = mongoose.model('Player', PlayerSchema);
var Challenge = mongoose.model('Challenge', ChallengeSchema);
var Unclaimed = mongoose.model('Unclaimed', UnclaimedSchema);

var pong = {
	init: function() {
    pong.channel = "#pongbot";
    pong.deltaTau = 0.94;
	},
  registerPlayer: function(user_name, cb) {
    var p = new Player({
      user_name: user_name,
      name: user_name,
      wins: 0,
      losses: 0,
      play_count: 0,
      elo: 0,
      tau: 0,
      image: '',
      rfid: '',
      uri: '',
      gender: '',
    });
    p.save( function(err) {
      if (err) return new Error(err);
      if (cb) cb();
    });
  },
  findPlayer: function(user_name, cb) {
    var q = Player.where({ user_name: user_name });
    q.findOne(function (err, user) {
      if (err) return handleError(err);
      if (user) {
        cb(user);
      } else {
        cb(false);
      }
    });
  },
  sendPlayer: function( user ) {
    rest.postJson( rfidServer + '/players/add', {user: user})
    .on('complete', function(data, response) {
      if (response.statusCode == 200 ) {
        console.log(chalk.green('User Added to RFID System')); 
      } else {
        console.log(chalk.red('Error Adding User!')); 
      }
    });
  },
  getEveryone: function() {
    Player.find({}, function(users) {
      if (err) return handleError(err);
      console.log(users)
    });
  },
  getActiveChallenges: function(cb) {
    var activeChallengesString = "Current active challenges: \n";
    Challenge.find({state: "Accepted"}).sort({'date': 'asc'}).limit(5).find(function(err, activeChallenges) {
      if (err) return handleError(err);
      if (activeChallenges) {
        activeChallenges.forEach(function(challenge, i) {
          var formattedDate = moment(challenge.date).tz(TIMEZONE).format('MMMM Do YYYY, h:mm:ss a');
          activeChallengesString += formattedDate + ": " + challenge.challenger + " vs " + challenge.challenged + "\n"
        });
        cb(activeChallengesString);
      } else {
        cb('Currently, there are no active challenges/matches.');
      }
    });
  },
  getProposedChallenges: function(cb) {
    var proposedChallengesString = "Current pending challenges: \n";
    Challenge.find({state: "Proposed"}).sort({'date': 'asc'}).limit(5).find(function(err, proposedChallenges) {
      if (err) return handleError(err);
      if (proposedChallenges) {
        proposedChallenges.forEach(function(challenge, i) {
          var formattedDate = moment(challenge.date).tz(TIMEZONE).format('MMMM Do YYYY, h:mm:ss a');
          proposedChallengesString += formattedDate + ": " + challenge.challenger + " is waiting for " + challenge.challenged + " to accept \n"
        });
        cb(proposedChallengesString);
      } else {
        cb('Currently, there are no pending challenges/matches.');
      }
    });
  },
  updateWins: function(user_name, cb) {
    var q = Player.where({ user_name: user_name });
    q.findOne(function (err, user) {
      if (err) return handleError(err);
      if (user) {
        user.wins++;
        user.play_count++;
        user.save(function (err, user) {
          if (err) return handleError(err);
          if (cb) cb();
        });
      }
    });
  },
  updateLosses: function(user_name, cb) {
    var q = Player.where({ user_name: user_name });
    q.findOne(function (err, user) {
      if (err) return handleError(err);
      if (user) {
        user.losses++;
        user.play_count++;
        user.save(function (err, user) {
          if (err) return handleError(err);
          if (cb) cb();
        });
      }
    });
  },
  alreadyChallenged: function(challengeId, cb) {
    Challenge.findOne({ _id: challengeId }, function(err, c) {
      message = "There's already an active challenge between " + c.challenged[0] + " and " + c.challenger[0];
      return message
    });
  },
  createSingleChallenge: function(challenger, challenged, cb) {
    var message = "";
    pong.checkChallenge(challenger, function(y) {
      if (y === false) {
        pong.checkChallenge(challenged, function(y2) {
          if (y2 === false) {
            var c = new Challenge({
              state: "Proposed",
              type: "Singles",
              date: Date.now(),
              challenger: [challenger],
              challenged: [challenged]
            });
            c.save( function(err, nc) {
              if (err) return new Error(err);
              pong.setChallenge(challenger, nc._id);
              pong.setChallenge(challenged, nc._id);
              message = challenger + " has challenged " + challenged + " to a ping pong match!";
              console.log(nc);
              cb(message);
            });
          } else {
            Challenge.findOne({ _id: y2.currentChallenge }, function(err, c) {
              cb("There's already an active challenge between " + c.challenger[0] + " and " + c.challenged[0]);
            });
          }
        });
      } else {
        Challenge.findOne({ _id: y.currentChallenge }, function(err, c) {
            cb("There's already an active challenge between " + c.challenged[0] + " and " + c.challenger[0]);
        });
      }
    });
  },
  createDoubleChallenge: function(c1, c2, c3, c4, cb) {
    var message = "";
    pong.checkChallenge(c1, function(y) {
      if (y === false) {
        pong.checkChallenge(c2, function(y) {
          if (y === false) {
            pong.checkChallenge(c3, function(y) {
              if (y === false) {
                pong.checkChallenge(c4, function(y) {
                  if (y === false) {
                      var c = new Challenge({
                        state: "Proposed",
                        type: "Doubles",
                        date: Date.now(),
                        challenger: [c1, c2],
                        challenged: [c3, c4]
                      });
                      c.save( function(err, nc) {
                        console.log(nc);
                        if (err) return new Error(err);
                        pong.setChallenge(c1, nc._id);
                        pong.setChallenge(c2, nc._id);
                        pong.setChallenge(c3, nc._id);
                        pong.setChallenge(c4, nc._id);
                        message = c1 + " and " + c2 + " have challenged " + c3 + " and " + c4 + " to a ping pong match!";
                        cb(message);
                      });
                  } else {
                    cb("There's already an active challenge.");
                  }
                });
              } else {
                cb("There's already an active challenge.");
              }
            });
          } else {
            cb("There's already an active challenge.");
          }
        });
      } else {
        cb("There's already an active challenge.");
      }
    });
  },
  checkChallenge: function(user_name, cb) {
    var q = Player.where({ user_name: user_name});
    q.findOne(function(err, u) {
      if (err) return handleError(err);
      if (u) {
        if (u.currentChallenge) {
          cb(u);
        } else {
          cb(false);
        }
      }
    });
  },
  setChallenge: function(user_name, id) {
    var q = Player.where({ user_name: user_name});
    q.findOne(function(err, u) {
      if (err) return handleError(err);
        if (u) {
          u.currentChallenge = id;
          u.save( function(err) {
            if (err) return new Error(err);
          });
        }
    });
  },
  removeChallenge: function(user_name, id) {
    var q = Player.where({ user_name: user_name});
    q.findOne(function(err, u) {
      if (err) return handleError(err);
        if (u) {
          u.currentChallenge = "";
          u.save( function(err) {
            if (err) return new Error(err);
          });
        }
    });
  },
  acceptChallenge: function(user_name, cb) {
    pong.checkChallenge(user_name, function(y) {
      if (y) {
        Challenge.findOne({ _id: y.currentChallenge }, function(err, c) {
          if (c.state === "Proposed") {
            c.state = "Accepted";
            cb("Accepted the proposal. " + c.challenged + " vs " + c.challenger);
            c.save(function (err) {
              if (err) return handleError(err);
            });
          } else if (challenge.state == "Accepted") {
            cb("You've already accepted the challenge.");
          } else {
            cb("No challenge to accept.")
          }
        });
      } else {
        cb("No challenge to accept.");
      }
    });
  },
  declineChallenge: function(user_name, cb) {
    pong.checkChallenge(user_name, function(y) {
      if (y) {
        Challenge.findOne({ _id: y.currentChallenge }, function(err, nc) {
          if (nc.state === "Proposed" || "Accepted") {
            nc.state = "Declined";
            nc.save(function(err) {
              if (err) return handleError(err);
                console.log(y.currentChallenge);
              Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
                if (err) return handleError(err);
              });
              cb("Declined the match.");
            });
          }
        });
      } else {
        cb("No challenge to decline!");
      }
    });
  },
  calculateTeamElo: function(p1, p2, cb) {
    var q = Player.where({ user_name: p1 });
    q.findOne(function (err, user) {
      if (err) return handleError(err);
      if (user) {
        var playerOneElo = user.elo;
        var qq = Player.where({ user_name: p2 });
        qq.findOne(function (err, user2) {
          if (err) return handleError(err);
          var playerTwoElo = user2.elo;
          var avgElo = (playerOneElo+playerTwoElo)/2;
          cb(avgElo);
        });
      }
    });
  },
  eloSinglesChange: function(w, l) {
    var q = Player.where({ user_name: w});
    q.findOne(function(err, winner) {
      if (err) return handleError(err);
      if (winner) {
        var qq = Player.where({ user_name: l});
        qq.findOne(function (err, loser) {
          if (err) return handleError(err);
            var e = 100 - Math.round(1 / (1 + Math.pow(10, ((loser.elo - winner.elo) / 400))) * 100);
            winner.tau = winner.tau || 0;
            winner.tau = winner.tau + .5;
            winner.elo = winner.elo + Math.round((e * Math.pow(pong.deltaTau,winner.tau)));
            loser.tau = loser.tau || 0;
            loser.tau = loser.tau + .5;
            loser.elo = loser.elo - Math.round((e * Math.pow(pong.deltaTau,loser.tau)));
            console.log("Elo: " + winner.elo);
            console.log("Elo: " + loser.elo);
            winner.save(function(err) {
              if (err) return handleError(err);
            });
            loser.save(function(err) {
              if (err) return handleError(err);
            });
        });
      }
    });
  },
  eloDoublesChange: function(p1, p2, p3, p4) {
    pong.calculateTeamElo(p1, p2, function(t1) {
      pong.calculateTeamElo(p3, p4, function(t2) {
        var q = Player.where({ user_name: p1});
        q.findOne(function(err, u1){
          if (err) return handleError(err);
          var q = Player.where({ user_name: p2});
          q.findOne(function(err, u2){
            if (err) return handleError(err);
              var q = Player.where({ user_name: p3});
              q.findOne(function(err, u3){
                if (err) return handleError(err);
                  var q = Player.where({ user_name: p4});
                  q.findOne(function(err, u4){
                    if (err) return handleError(err);
                    var e = 100 - Math.round(1 / (1 + Math.pow(10, ((t2 - u1.elo) / 400))) * 100);
                    var e2 = 100 - Math.round(1 / (1 + Math.pow(10, ((t2 - u2.elo) / 400))) * 100);
                    var e3 = 100 - Math.round(1 / (1 + Math.pow(10, ((u3.elo - t1) / 400))) * 100);
                    var e4 = 100 - Math.round(1 / (1 + Math.pow(10, ((u4.elo - t1) / 400))) * 100);
                    u1.tau = u1.tau || 0;
                    u1.tau = u1.tau + .5;
                    u1.elo = u1.elo + Math.round((e * Math.pow(pong.deltaTau,u1.tau)));
                    u2.tau = u2.tau || 0;
                    u2.tau = u2.tau + .5;
                    u2.elo = u2.elo + Math.round((e2 * Math.pow(pong.deltaTau,u2.tau)));
                    u3.tau = u3.tau || 0;
                    u3.tau = u3.tau + .5;
                    u3.elo = u3.elo - Math.round((e3 * Math.pow(pong.deltaTau,u3.tau)));
                    u4.tau = u4.tau || 0;
                    u4.tau = u4.tau + .5;
                    u4.elo = u4.elo - Math.round((e4 * Math.pow(pong.deltaTau,u4.tau)));
                    console.log("Elo: " + u1.elo);
                    console.log("Elo: " + u2.elo);
                    console.log("Elo: " + u3.elo);
                    console.log("Elo: " + u4.elo);
                    u1.save(function(err) {
                      if (err) return handleError(err);
                    });
                    u2.save(function(err) {
                      if (err) return handleError(err);
                    });
                    u3.save(function(err) {
                      if (err) return handleError(err);
                    });
                    u4.save(function(err) {
                      if (err) return handleError(err);
                    });
                  });
              });
          });
        });
      });
    });
  },
  win: function(user_name, cb) {
    pong.checkChallenge(user_name, function(y) {
      if (y) {
        Challenge.findOne({ _id: y.currentChallenge }, function(err, nc) {
        if (nc.state === "Proposed") {
          cb("Challenge needs to be accepted before recording match.");
        } else if (nc.type === "Doubles") {
          if (user_name === nc.challenger[0] || user_name === nc.challenger[1]) {
            Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
              if (err) return handleError(err);
                console.log("Recorded challenge.")
            });
            pong.eloDoublesChange(nc.challenger[0], nc.challenger[1], nc.challenged[0], nc.challenged[1]);
            pong.updateWins(nc.challenger[0]);
            pong.updateWins(nc.challenger[1]);
            pong.updateLosses(nc.challenged[0]);
            pong.updateLosses(nc.challenged[1]);
            nc.state = "Finished";
            y.save(function(err) {
              if (err) return handleError(err);
              cb("Match has been recorded. " + nc.challenger[0] +  " and " + nc.challenger[1] +  " has defeated " + nc.challenged[0] + " and " + nc.challenged[1]);
            });
          } else {
            Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
              if (err) return handleError(err);
                console.log("Recorded challenge.")
            });
            pong.eloDoublesChange(nc.challenged[0], nc.challenged[1], nc.challenger[0], nc.challenger[1]);
            pong.updateWins(nc.challenged[0]);
            pong.updateWins(nc.challenged[1]);
            pong.updateLosses(nc.challenger[0]);
            pong.updateLosses(nc.challenger[1]);
            nc.state = "Finished";
            y.save(function(err) {
              if (err) return handleError(err);
              cb("Match has been recorded. " + nc.challenged[0] +  " and " + nc.challenged[1] +  " has defeated " + nc.challenger[0] + " and " + nc.challenger[1]);
            });
          }
        } else if (nc.type === "Singles") {
          if (user_name === nc.challenger[0]) {
            Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
              if (err) return handleError(err);
                console.log("Recorded challenge.")
            });
            pong.eloSinglesChange(nc.challenger[0], nc.challenged[0]);
            pong.updateWins(nc.challenger[0]);
            pong.updateLosses(nc.challenged[0]);
            nc.state = "Finished";
            y.save(function(err) {
              if (err) return handleError(err);
              cb("Match has been recorded. " + nc.challenger[0] + " has defeated " + nc.challenged[0]);
            });
          } else {
            Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
              if (err) return handleError(err);
                console.log("Recorded challenge.")
            });
            pong.eloSinglesChange(nc.challenged[0], nc.challenger[0]);
            pong.updateWins(nc.challenged[0]);
            pong.updateLosses(nc.challenger[0]);
            nc.state = "Finished";
            y.save(function(err) {
              if (err) return handleError(err);
              cb("Match has been recorded. " + nc.challenged[0] + " has defeated " + nc.challenger[0]);
            });
          }
        }
      });
      } else {
        cb("Challenge does not exist, or has been recorded already.");
      }
    });
  },
  lose: function(user_name, cb) {
    pong.checkChallenge(user_name, function(y) {
      if (y) {
        Challenge.findOne({ _id: y.currentChallenge }, function(err, nc) {
        if (nc.state === "Proposed") {
          cb("Challenge needs to be accepted before recording match.");
        } else if (nc.type === "Doubles") {
          if (user_name === nc.challenged[0] || user_name === nc.challenged[1]) {
            Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
              if (err) return handleError(err);
                console.log("Recorded challenge.")
            });
            pong.eloDoublesChange(nc.challenger[0], nc.challenger[1], nc.challenged[0], nc.challenged[1]);
            pong.updateWins(nc.challenger[0]);
            pong.updateWins(nc.challenger[1]);
            pong.updateLosses(nc.challenged[0]);
            pong.updateLosses(nc.challenged[1]);
            nc.state = "Finished";
            nc.save(function(err) {
              if (err) return handleError(err);
              cb("Match has been recorded. " + nc.challenger[0] +  " and " + nc.challenger[1] +  " has defeated " + nc.challenged[0] + " and " + nc.challenged[1]);
            });
          } else {
            Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
              if (err) return handleError(err);
                console.log("Recorded challenge.")
            });
            pong.eloDoublesChange(nc.challenged[0], nc.challenged[1], nc.challenger[0], nc.challenger[1]);
            pong.updateWins(nc.challenged[0]);
            pong.updateWins(nc.challenged[1]);
            pong.updateLosses(nc.challenger[0]);
            pong.updateLosses(nc.challenger[1]);
            nc.state = "Finished";
            nc.save(function(err) {
              if (err) return handleError(err);
              cb("Match has been recorded. " + nc.challenged[0] +  " and " + nc.challenged[1] +  " has defeated " + nc.challenger[0] + " and " + nc.challenger[1]);
            });
          }
        } else if (nc.type === "Singles") {
          if (user_name === nc.challenged[0]) {
            Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
              if (err) return handleError(err);
                console.log("Recorded challenge.")
            });
            pong.eloSinglesChange(nc.challenger[0], nc.challenged[0]);
            pong.updateWins(nc.challenger[0]);
            pong.updateLosses(nc.challenged[0]);
            nc.state = "Finished";
            nc.save(function(err) {
              if (err) return handleError(err);
              cb("Match has been recorded. " + nc.challenger[0] + " has defeated " + nc.challenged[0]);
            });
          } else {
            Player.update( {currentChallenge: nc._id}, {currentChallenge: null}, {multi: true}, function(err) {
              if (err) return handleError(err);
                console.log("Recorded challenge.")
            });
            pong.eloSinglesChange(nc.challenged[0], nc.challenger[0]);
            pong.updateWins(nc.challenged[0]);
            pong.updateLosses(nc.challenger[0]);
            nc.state = "Finished";
            nc.save(function(err) {
              if (err) return handleError(err);
              cb("Match has been recorded. " + nc.challenged[0] + " has defeated " + nc.challenger[0]);
            });
          }
        }
      });
      } else {
        cb("Challenge does not exist, or has been recorded already.");
      }
    });
  },
  findDoublesPlayers: function(p2, p3, p4, cb) {
    var q = Player.where({ user_name: p2});
    q.findOne(function(err, u2){
      if (err) return handleError(err);
      if(u2) {
        var q = Player.where({ user_name: p3});
        q.findOne(function(err, u3){
          if (err) return handleError(err);
          if(u3) {
            var q = Player.where({ user_name: p4});
            q.findOne(function(err, u4){
              if (err) return handleError(err);
              if(u4) {
                cb(true);
              } else {
                cb("Opponent 2 could not be found.");
              }
            });
          } else {
            cb("Opponent 1 could not be found.");
          }
        });
      } else {
        cb("Teammate could not be found.");
      }
    });
  },
  reset: function(user_name, cb) {
    var q = Player.where({ user_name: user_name });
    q.findOne(function (err, user) {
      if (err) return handleError(err);
      if (user) {
        user.wins = 0;
        user.losses = 0;
        user.elo = 0;
        user.tau = 1;
        user.save(function (err, user) {
          if (err) return handleError(err);
          cb();
        });
      }
    });
  },
  getRankings: function(players){
    var rank = 1;
    var totalRankings = "";
    players.forEach(function(player, i){
      if (players[i - 1]) {
        if (players[i - 1].elo != player.elo){
          rank = i + 1;
        }
      }
      var playerstring = rank + ". *" + player.user_name + "* " + pluralize('win', player.wins, true) + " " + pluralize('loss', player.losses, true) + " [" + player.elo  + "]" + "\n";
      totalRankings += playerstring;
    })
    return totalRankings
  },
  claimTag: function(user_name, cb) {
    return true;
  },
  getDuelGif: function(cb) {
    var gifs = [
      "http://i.imgur.com/m0mVPXt.gif",
      "http://i.imgur.com/wMgCOnH.gif",
      "http://i.imgur.com/d8yvGgS.gif",
      "http://i.imgur.com/jddSDqE.gif",
      "http://i.imgur.com/YTfYIvL.gif",
      "http://i.imgur.com/Jbphzw9.gif",
      "http://i.imgur.com/qKassrW.gif",
      "http://i.imgur.com/oIxjQcA.gif",
      "http://i.imgur.com/f5MVC3p.gif",
      "http://i.imgur.com/zgwaaYx.gif",
      "http://i.imgur.com/MiOY60j.gif",
      "http://i.imgur.com/ATQiM2x.gif",
      "http://i.imgur.com/qONAgv2.gif",
      "http://i.imgur.com/khGAqip.gif",
      "http://i.imgur.com/LU5E2mI.gif",
      "http://i.imgur.com/5Wxq8Sb.gif",
      "http://i.imgur.com/BgFiaah.gif",
      "http://i.imgur.com/Mh5qnlB.gif",
      "http://i.imgur.com/eQGN47S.gif",
      "http://i.imgur.com/6FC2LBa.gif",
      "http://i.imgur.com/vJk2Feq.gif",
      "http://i.imgur.com/CxGW3oH.gif",
      "http://i.imgur.com/qm6B423.gif",
      "http://i.imgur.com/qm6B423.gif",
      "http://i.imgur.com/MAjoX5D.gif",
      "http://i.imgur.com/2mY575N.gif",
      "http://i.imgur.com/AIMqKoW.gif",
      "http://i.imgur.com/4LvS9zJ.gif",
      "http://i.imgur.com/mPjlDkZ.gif",
      "http://i.imgur.com/wei0RrF.gif",
      "http://i.imgur.com/V2bzEnG.gif",
      "http://i.imgur.com/58hFsyK.gif",
      "http://i.imgur.com/v3LgsEw.gif",
      "http://i.imgur.com/rF1uoil.gif",
      "http://i.imgur.com/r924Rvb.gif",
      "http://i.imgur.com/OnaqJdR.gif",
      "http://i.imgur.com/YOLNpSl.gif",
      "http://i.imgur.com/QjrgyC2.gif",
      "http://i.imgur.com/m5UjbMU.gif"
    ]
    var rand = gifs[Math.floor(Math.random() * gifs.length)];
    cb(rand);
  }
};

pong.init();

app.post('/', function(req, res){
    console.log("Got a post from " + req.body.user_name);
    var hook = req.body;
    if(hook) {
    	var params = hook.text.split(" ");
    	var command = params[1];
    	switch(command) {
      case "register":
          var message = "";
          pong.findPlayer(hook.user_name, function(user) {
            if (user) {
              message = "You've already registered!";
            } else if (user === false) {
              pong.registerPlayer(hook.user_name);
              message = "Successfully registered! Welcome to the system, " + hook.user_name + ".";
            }
            res.json({text: message});
          });
          break;
      case "claim":
          // Check if registered, 
          // pongbot claim RFID NAME GENDER
          var message = "";
          pong.findPlayer(hook.user_name, function(user) {
            if (user) {
              var q = Unclaimed.where({ tag: params[2] });
              q.findOne(function (err, tag) {
                if (err) return handleError(err);
                if (tag) {
                  user.rfid   = tag.tag;
                  user.name   = params[3] || hook.user_name;
                  user.gender = params[4] || "";
                  user.save();

                  // Pass Player to RFID System
                  pong.sendPlayer( user );
                  
                  message = "Added tag " + tag.tag + " to your profile!";
                  res.json({text: message});
                  tag.remove();                  
                } else {
                  message = "Invalid tag or already claimed. Go scan and come back.";    
                  res.json({text: message});
                }
              });

            } else if (user === false) {
              message = "You're not registered! Use the command 'pongbot register' to get into the system.";
              res.json({text: message});
            }
          });
          break;
    	case "challenge":
          var message = "";
          // check if registered
          pong.findPlayer(hook.user_name, function(user) {
            if (user) {
              if (params[2] == "doubles")  {
                pong.findDoublesPlayers(params[3], params[5], params[6], function(m) {
                  if (m === true) {
                    pong.createDoubleChallenge(hook.user_name, params[3], params[5], params[6], function(m) {
                      pong.getDuelGif( function(gif) {
                        var responder = m + " " + gif;
                        res.json({text: responder});
                      });
                    });
                  } else {
                    res.json({text: m});
                  }
                });
              } else if (params[2] == "singles") {
                pong.findPlayer(params[3], function(user) {
                  if (user) {
                    pong.createSingleChallenge(hook.user_name, params[3], function(m) {
                      pong.getDuelGif( function(gif) {
                        var responder = m + " " + gif;
                        res.json({text: responder});
                      });
                    });
                  } else {
                    message = "Could not find a player with that name.";
                    res.json({text: message});
                  }
                });
              } else {
                message = "Invalid params. 'pongbot challenge _<singles|doubles> <opponent|teammate>_ against _<opponent> <opponent>_ '";
                res.json({text: message});
              }
            } else if (user === false) {
              message = "You're not registered! Use the command 'pongbot register' to get into the system.";
              res.json({text: message});
            }
          });
    	    break;
    	case "accept":
    	    pong.acceptChallenge(hook.user_name, function(message) {
            res.json({text: message});
          });
    	    break;
    	case "decline":
    	    pong.declineChallenge(hook.user_name, function(message) {
            res.json({text: message});
          });
    	    break;
    	case "lost":
          pong.findPlayer(hook.user_name, function(user) {
            if (user) {
              pong.lose(hook.user_name, function(m) {
                res.json({text: m});
              });
            } else if (user === false) {
              message = "You're not registered! Use the command 'pongbot register' to get into the system.";
              res.json({text: message});
            }
          });
    	    break;
    	case "won":
    	    res.json({text: "Only the player/team that lost can record the game."});
    	    break;
      case "rank":
          var message = "";
          var usertosearch = params[2] || hook.user_name;
          pong.findPlayer(usertosearch, function(user){
            if (user) {
              message = user.user_name + ": " + user.wins + " wins, " + user.losses + " losses. Elo: " + user.elo;
            } else if (user === false) {
              message = "Could not find a player with that name."
            }
            res.json({text: message});
          });
          break;
      case "leaderboard":
          var topN = params[2] || 15;
          Player.find({$or:[{"wins":{"$ne":0}},{"losses":{"$ne":0}}]}).sort({'elo': 'descending', 'wins': 'descending'}).limit(topN).find( function(err, players) {
            if (err) return handleError(err);
            var totalPlayers = pong.getRankings(players);
            res.json({text: totalPlayers});
          });
          break;
      case "matches":
      case "active":
        pong.getActiveChallenges(function(activeChallenges) {
          pong.getProposedChallenges(function(proposedChallenges){
            var activeAndProposedChallenges = activeChallenges + "\n" + proposedChallenges;
            res.json({text: activeAndProposedChallenges})
          })
        });
        break;
      case "reset":
          var message = "";
          if (hook.user_name === "vy") {
            pong.findPlayer(params[2], function(user) {
              if (user) {
                pong.reset(params[2], function() {
                  message = params[2] + "'s stats have been reset.";
                  res.json({text: message});
                });
              } else if (user === false) {
                message = "You're not registered! Use the command 'pongbot register' to get into the system.";
                res.json({text: message});
              }
            });
          } else {
            message = "You do not have admin rights.";
            res.json({text: message});
          }
          break;
      case "gifs":
      case "gif":
        pong.getDuelGif( function(gif) {
          res.json({text: gif});
        });
        break;
      case "source":
          res.json({text: "https://github.com/andrewvy/opal-pongbot"});
          break;
      case "help":
          res.json({text: "https://github.com/andrewvy/opal-pongbot"});
          break;
    	default:
    	    res.json({text: "I couldn't understand that command. Use 'pongbot help' to get a list of available commands."});
          break;
    	}
    }
});

app.post('/commands', function(req, res){
  console.log("Got a post from " + req.body.user_name);
      switch(req.body.command) {
        case "/rank":
          var message = "";
          var usertosearch = req.body.text || req.body.user_name;
          pong.findPlayer(usertosearch, function(user){
            if (user) {
              message = user.user_name + ": " + user.wins + " wins, " + user.losses + " losses. Elo: " + user.elo;
            } else if (user === false) {
              message = "Could not find a player with that name."
            }
            res.send(message);
          });
        break;
        case "/leaderboard":
          var message = "";
          Player.find({}).sort({'elo': 'descending'}).find( function(err, players) {
            if (err) return handleError(err);
            for (var i=0;i<players.length;i++) {
              var actual = i + 1;
              if (i == 6) {
                res.send(message);
                break;
              }
              message = message + actual + ") " + players[i].user_name + ": " + players[i].wins + "-" + players[i].losses + " Elo: " + players[i].elo + "\n";
            }
          });
        break;
      }
});

app.get('/api/rankings', function(req, res) {
  Player.find({}).sort({'elo': 'descending'}).find( function(err, players) {
    if (err) return handleError(err);
    // Need to add play_count as sum(wins + losses)
    res.json(players);
  });
});

app.get('/api/matches', function(req, res) {
  Challenge.find({}).sort({'date': 'desc'}).limit(10).find( function(err, challenges) {
    if (err) return handleError(err);
    res.json(challenges);
  });
});

// up/down endpoint
app.get('/api/system/ping', function(req, res) {
  res.json({"ping": "pong"});
});


/*****************************
 *
 * RFID SYSTEM INTEGRATION
 *
 *****************************/

// Find Scanned Tag
app.get('/rfid/find/:tag', function(req, res) {
  var q = Player.where({ rfid: req.params.tag });
  q.findOne(function (err, user) {
    if (err) return handleError(err);
    if (user) {
      res.json( user );
    }
  });
});

// Add Unclaimed Tag to Mongo
app.get('/rfid/unclaimed/:tag', function(req, res) {
  console.log(chalk.green('Looking for Tag: ' + req.params.tag));
  if (req.params.tag !== undefined ) {
    Unclaimed.findOne({ tag: req.params.tag }, function(err, tag) {
      if (!tag) {
        var t = new Unclaimed({
          tag: req.params.tag
        });
        t.save();
      } else {
        console.log(chalk.red('Duplicate!'));
      }
    });
  }
  res.status(200).end();
});

// Show unclaimed tags
app.get('/rfid/unclaimed', function(req, res) {
  Unclaimed.find('','tag', function(err, tags) {
    if (err) return handleError(err);
    res.json( tags );
  });
});

// Get leaderboard JSON to reflect on RFID Screen
app.get('/leaderboard', function(req, res){
  Player.find({$or:[{"wins":{"$ne":0}},{"losses":{"$ne":0}}]}).sort({'elo': 'descending', 'wins': 'descending'}).limit(10).find( function(err, players) {
    if (err) return handleError(err);
    res.json(players);
  });
});

// Get Challenges JSON
app.get('/challenges', function(req, res){
  Challenge.find(function(err, challenges) {
    res.json(challenges);
  });
});

// Record a finished RFID match
app.get('/rfid/match/:winner/:loser', function(req, res){

  console.log(chalk.green('Incoming match statistics.'));

  var w = req.params.winner,
      l = req.params.loser;

  // Create a new, finished challenge    
  var c = new Challenge({
    state: "Finished",
    type: "Singles",
    date: Date.now(),
    challenger: [ w ],
    challenged: [ l ]
  });
  c.save( function(err, nc) {
    if (err) {
      console.log(chalk.red('Something went wrong.'));
      res.json({recorded: false});
      return new Error(err);
    } else {
      // Update Stats if Everything goes well
      pong.eloSinglesChange( w, l );
      pong.updateWins( w );
      pong.updateLosses( l );
      console.log(chalk.yellow('Recorded Match!!!'));
      res.json({recorded: true});        
    }
  }); 
});




app.listen(process.env.PORT || 4000);
console.log("Listening on port 4000!");
