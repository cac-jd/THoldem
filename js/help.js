/* In-app help (rendered in the Help tab, inside <div class="page help">). */
window.THoldemHelp = `
<h2>How to run your game</h2>
<p class="muted">THoldem is the tournament director: it runs the blind clock, calls out the levels, keeps track of chips, the pot and the prize money. You still deal real cards with real chips. Everything saves automatically in this browser.</p>

<div class="card">
  <h3 style="margin-top:0">Game night in 2 minutes</h3>
  <ol>
    <li><b>Players &amp; Payouts</b> (<kbd>3</kbd>): set the number of players (2–12), type their names, the buy-in and the starting stack. Payout percentages are already filled in. Press <b>Suggest</b> to recalculate them for your player count.</li>
    <li><b>Blinds &amp; Breaks</b> (<kbd>2</kbd>): tap a preset. <b>Home Game</b> (15-minute levels, a break every 4 levels) is a good first choice. The blinds are built to fit your starting stack, so set that first.</li>
    <li><b>Chips</b> (<kbd>4</kbd>): enter the colours and values of your chip set and press <b>Auto-distribute starting stack</b>. It shows how many of each chip to give every player.</li>
    <li>Go to the <b>Table</b> (<kbd>1</kbd>) and press <b>▶ Start</b>, tap the big clock or press <kbd>Space</kbd>. Shuffle up and deal!</li>
    <li>Optional: press <b>New hand</b> (<kbd>N</kbd>) at the start of every deal. It moves the dealer button and posts the blinds, and then you can track bets on screen. If you only want a clock, turn off <i>Track player stacks, bets &amp; pot</i> on the Players tab.</li>
  </ol>
  <p class="muted">Browsers only play sound after you click or press a key on the page. Check the volume under <b>Sound &amp; Look</b>, where the ▶ button next to each sound plays a preview.</p>
</div>

<h3>Running the clock</h3>
<table>
  <tr><td><b>▶ Start / ❚❚ Pause</b></td><td>Starts or pauses the countdown. Tapping the big clock in the middle of the table or pressing <kbd>Space</kbd> does the same.</td></tr>
  <tr><td><b>⏮ / ⏭</b></td><td>Go to the previous or next level (a break counts as a step). The level starts again from its full length.</td></tr>
  <tr><td><b>−1:00 / +1:00</b></td><td>Take away or add one minute on the current level.</td></tr>
  <tr><td><b>↺ Level</b></td><td>Restart the current level from its full time.</td></tr>
</table>
<ul>
  <li><b>Warnings:</b> 5 minutes before the blinds go up, a banner at the top shows the next blinds, a chime plays and the voice says “Blinds go up in 5 minutes”. With <i>Extra 1-minute warning</i> turned on you get a second warning at 1:00. The clock turns amber during the warning and red in the last minute. Close the banner with ✕. Change the timing under <b>Sound &amp; Look</b> (set it to 0 for no warning).</li>
  <li><b>Blinds up:</b> a full-screen <i>BLINDS UP</i> card shows the new level while the Prime Time fanfare plays, and then the voice reads out the blinds. It closes by itself after a few seconds, or when you tap it or press <kbd>Esc</kbd> or <kbd>Space</kbd> (Space only closes the card here — it doesn't pause the clock).</li>
  <li><b>Breaks:</b> a <i>TAKE A BREAK</i> card shows how long the break is and which chips to colour up, and the clock counts the break down. To make the clock wait for everyone to come back, tick <i>Pause the clock when a break ends</i> at the bottom of <b>Blinds &amp; Breaks</b>. The next level then waits until you press Start.</li>
  <li><b>Laptop asleep or tab in the background?</b> The clock runs on real time, not on the computer. When you come back it catches up to the correct level and time and announces the level it is on. It also keeps running if you reload or close the page (catching up silently).</li>
  <li><b>End of the structure:</b> the clock never runs dry — when it reaches your last level it adds another one about 25% higher (turn this off under <b>Blinds &amp; Breaks</b> if you'd rather it stopped at <i>Structure complete</i>).</li>
  <li>The side panels show the current and next blinds, the time until the next break, the tournament time, players left, the average stack (also in big blinds), the chips in play and the prize pool with its payouts.</li>
</ul>

<h3>Tracking the pot</h3>
<p class="muted">This is optional, but it keeps every stack accurate so you never have to count chips.</p>
<ol>
  <li><b>New hand</b> (<kbd>N</kbd>) moves the dealer button one seat to the left (the first hand keeps it where it is). It then posts the small and big blind for the current level and selects the first player to act. Heads-up, the dealer posts the small blind. On a break no blinds are posted.
    <br><span class="muted">Antes: if the ante is the same as the big blind, it is a <i>big-blind ante</i> and the big blind pays one ante for the whole table. A smaller ante is paid by every player. Antes go straight into the pot.</span></li>
  <li><b>The selected player</b> has a gold outline. Tap any seat to select someone else. After each action the next player still in the hand is selected for you.
    <ul>
      <li><b>Call</b> (<kbd>C</kbd>) matches the biggest bet. The button shows the amount, e.g. <i>Call 300</i>, or <i>Check</i> if there is nothing to call.</li>
      <li><b>Fold</b> (<kbd>X</kbd>) greys out the seat for this hand. <b>All-in</b> puts the player's whole stack in.</li>
      <li><b>Bet / raise:</b> type an amount, or tap the chips in the tray to build it (each tap adds that chip; <b>C</b> clears it). Then press <b>Bet</b> or <kbd>Enter</kbd>. The amount is <b>added to what the player already has in front of them</b>. So to raise the big blind of 200 to 600, the big blind enters 400. A bet bigger than the stack puts the player all-in.</li>
    </ul>
  </li>
  <li><b>Collect</b> sweeps the bets into the middle between betting rounds. You don't have to use it, because awarding the pot collects them too.</li>
  <li><b>🏆 Award pot</b>, or tap the pot: tap the winner's seat, then <b>✓ Confirm award</b>. For a split pot, tap every winner. Always pick the <b>best hand first</b>: an all-in player only wins what they could cover, and any side pot stays open for you to award next. Splits are paid in whole chips; any odd chip goes to the first winner to the left of the button. <b>Cancel</b> or <kbd>Esc</kbd> backs out.
    <ul>
      <li>When everyone else folds, the last player gets the pot automatically.</li>
      <li><b>Side pots are handled for you.</b> If the winner was all-in for less, they only win what they could match. THoldem keeps the rest as a side pot and asks you to tap <i>its</i> winner. Chips that nobody called go back to their owner.</li>
      <li>If you press New hand before the pot is awarded, the leftover chips carry over into the next pot.</li>
    </ul>
  </li>
  <li><b>↶ Undo</b> (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) steps back through the last 40 table actions: bets, folds, awards, new hands, knockouts, rebuys and stack edits. It does not change the clock, and the undo history is cleared when the page reloads.</li>
  <li><b>Adding chips to the pot without a player:</b> when no seat is selected (for example after the pot has been awarded), the Bet button changes to <b>Add to pot</b>. Build an amount and press it to add chips straight to the pot.</li>
</ol>

<h3>Players</h3>
<ul>
  <li>Tap a seat that is <b>already selected</b>, or any knocked-out seat, to open the <b>player menu</b>. With stack tracking off, one tap is enough.
    <table>
      <tr><td><b>Name / Stack</b></td><td>Rename the player, or correct their chip count after a miscount or colour-up. Press <b>Save</b> or <kbd>Enter</kbd>.</td></tr>
      <tr><td><b>Give button</b></td><td>Moves the dealer button to this seat.</td></tr>
      <tr><td><b>Rebuy</b></td><td>Adds the rebuy chips and puts the rebuy money into the prize pool. It also brings a busted player back into the game.</td></tr>
      <tr><td><b>Add-on</b></td><td>Adds the add-on chips and money (for players still in).</td></tr>
      <tr><td><b>Knock out</b></td><td>Asks you to confirm, then records their finishing place. Chips they already bet stay in the pot.</td></tr>
      <tr><td><b>Bring back</b></td><td>Undoes a knockout. The player comes back with 0 chips, so set their stack and press Save.</td></tr>
    </table>
  </li>
  <li><b>Bust-outs:</b> after a pot is awarded, THoldem asks what to do with each player who has no chips left: <b>Knock out</b>, <b>Rebuy</b> or <b>Later</b>. When only one player is left, the champion is crowned on screen.</li>
  <li><b>Players &amp; Payouts tab:</b> event name (shown in the top bar), currency, number of players (changing it keeps existing stacks) and <b>🔀 Shuffle seats</b>, which also draws the button at random. Until the first hand is dealt, stacks follow the starting stack.</li>
  <li><b>Money:</b> prize pool = players × buy-in + rebuys + add-ons, minus the rake/fee %. Payouts are percentages per place (<b>+ Place</b>, <b>− Place</b>, <b>Suggest</b>) and should add up to 100%. The standings table lists chip counts, finishing places and prizes.</li>
</ul>

<h3>Blinds &amp; Breaks</h3>
<ul>
  <li><b>Presets:</b> <b>Home Game</b> (15 min), <b>Turbo</b> (10 min), <b>Deep Stack</b> (20 min, 200 big blinds deep) and <b>Hyper</b> (5 min, no breaks or antes). A preset replaces every level and resets the clock to level 1, paused. If a game is under way it asks first. Players and stacks are not touched.</li>
  <li><b>Quick build</b> works the same way with your own numbers. <i>Starting depth</i> is how many big blinds the starting stack is worth at level 1. <i>Smallest chip</i> keeps every blind a multiple of that chip. <i>Blind speed</i> sets how fast the blinds rise, and you can also choose the break frequency and the ante type and start level. Press <b>Generate structure</b>.</li>
  <li><b>Edit any level inline:</b> small blind, big blind, ante and minutes. Changes apply immediately, even while the clock runs. Changing the current level's minutes adds or removes that time from the clock. The current level is highlighted in gold, and <i>Starts at</i> shows when each level begins.</li>
  <li><b>Row buttons:</b> <b>▶</b> jumps the clock to that level, <b>↑ ↓</b> move it, <b>⧉</b> duplicates it and <b>✕</b> deletes it.</li>
  <li><b>+ Level</b> adds a level about 25% higher at the end, and <b>+ Break</b> adds a 10-minute break at the end (move it into place with ↑). To rename a break, type in its name box. <b>Set all level lengths…</b> changes every level at once and leaves the breaks alone.</li>
  <li><b>Colour-up:</b> each break row shows which small chips are no longer needed after it, so you can swap them for bigger ones. A warning appears above the table if something looks wrong, for example if the big blind goes down.</li>
</ul>

<h3>Chips</h3>
<ul>
  <li>For each denomination, set the colour, value, name and how many each player starts with. <b>+ Denomination</b> adds one and <b>✕</b> removes one. These colours are used for the chip tray and the chip stacks on the table.</li>
  <li><b>Auto-distribute starting stack</b> splits the starting stack into chips and keeps enough small chips for change. If the chip total doesn't match the starting stack you'll see a warning, with a button to use the chip total as the starting stack.</li>
  <li><b>Chips needed for the whole table</b> tells you how many of each chip to count out. Keep some extra for rebuys and add-ons.</li>
  <li>The <b>Color-up planner</b> lists, for every break, the chips you can colour up. The break screen and the voice announce it too.</li>
</ul>

<h3>Sound &amp; Look</h3>
<ul>
  <li><b>Alerts:</b> warning time (in minutes, halves allowed, 0 = off), the extra 1-minute warning, volume and sound on/off (also the 🔊 button or <kbd>M</kbd>).</li>
  <li><b>Sounds:</b> choose a sound for each moment: <i>Blinds go up</i> (the Prime Time fanfare by default), <i>Warning</i> and <i>Break starts</i>. The choices are Prime Time Fanfare, Shuffle Up Stinger, Casino Bell, Air Horn, Ding-Dong Chime, Countdown Beeps, Lounge Break and Silent. Press ▶ to preview. Press <b>⬆</b> to upload your own clip (mp3, wav, ogg…) for that moment. It is saved in this browser.</li>
  <li><b>Voice:</b> announces the new blinds, the warnings and breaks after the sound. The voices available depend on your computer and browser.</li>
  <li><b>Desktop notifications:</b> shows a pop-up for level changes and warnings while THoldem is in a background tab or window. Your browser asks for permission the first time.</li>
  <li><b>Keep the screen awake</b> stops the screen from sleeping while the clock runs, in browsers that support it.</li>
  <li><b>Table look:</b> felt colour, rail (black leather, walnut or burgundy), the text printed on the felt (leave it empty to hide it) and <i>compact numbers</i> (1.5K instead of 1,500).</li>
</ul>

<h3>Keyboard shortcuts</h3>
<table>
  <tr><td><kbd>Space</kbd></td><td>Start / pause the clock</td></tr>
  <tr><td><kbd>→</kbd> / <kbd>←</kbd></td><td>Next / previous level</td></tr>
  <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>Add / remove one minute</td></tr>
  <tr><td><kbd>N</kbd></td><td>New hand (moves the button, posts blinds &amp; antes)</td></tr>
  <tr><td><kbd>C</kbd></td><td>Call or check for the selected player</td></tr>
  <tr><td><kbd>X</kbd></td><td>Fold the selected player</td></tr>
  <tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd> (<kbd>⌘</kbd>+<kbd>Z</kbd> on Mac)</td><td>Undo the last table action</td></tr>
  <tr><td><kbd>F</kbd></td><td>Fullscreen on / off</td></tr>
  <tr><td><kbd>M</kbd></td><td>Mute / unmute</td></tr>
  <tr><td><kbd>1</kbd>–<kbd>6</kbd></td><td>Switch tabs: Table, Blinds &amp; Breaks, Players &amp; Payouts, Chips, Sound &amp; Look, Help</td></tr>
  <tr><td><kbd>Esc</kbd></td><td>Close a pop-up or the blinds-up card, cancel awarding the pot, or deselect a seat</td></tr>
  <tr><td><kbd>B</kbd></td><td>Big clock mode — a huge clock and blinds for a TV across the room (press again for the table)</td></tr>
</table>
<p class="muted">Shortcuts are ignored while you are typing in a box or while a pop-up is open. Click on an empty part of the page first.</p>

<h3>Tips for a TV or second screen</h3>
<ul>
  <li>Connect the laptop to the TV (HDMI, or cast/mirror the browser tab), open the <b>Table</b> and press <kbd>F</kbd> for fullscreen. The tabs are hidden so the table fills the screen.</li>
  <li>To make everything bigger, use browser zoom (<kbd>Ctrl</kbd> <kbd>+</kbd>, or <kbd>⌘</kbd> <kbd>+</kbd> on Mac). The table resizes to fit the window.</li>
  <li>For a clock you can read from the couch, press <b>⏱ Big clock</b> (or <kbd>B</kbd>): a huge countdown, the blinds and ante, what's next and when the break is. Press it again to go back to the table.</li>
  <li>If you don't want to track bets at all, turn off <i>Track player stacks, bets &amp; pot</i> (Players &amp; Payouts). The pot and hand buttons disappear.</li>
  <li>Plug in the charger. <i>Keep the screen awake</i> is on by default, but a laptop on battery may still sleep, and the clock catches up when it wakes.</li>
  <li>Open THoldem in <b>one</b> tab only. Every open tab runs the clock and plays the sounds.</li>
</ul>

<h3>Saving</h3>
<ul>
  <li>Everything is saved automatically in <b>this browser on this device</b>, including the running clock, so a reload or crash loses nothing. A private/incognito window forgets it all when closed.</li>
  <li><b>⬇ Export setup</b> (Sound &amp; Look) downloads a file with your structure, chips, player names, money, payouts and sound/look settings. It does not include the tournament in progress (clock, stacks) or uploaded sound clips. <b>⬆ Import setup</b> loads such a file and starts a fresh tournament with it.</li>
  <li><b>Start a new tournament</b> (Players &amp; Payouts) resets the clock to level 1, restores every stack, and clears the pot, rebuys and knockouts. Your structure and settings are kept.</li>
  <li><b>Reset everything</b> (Sound &amp; Look) wipes it all back to the factory defaults.</li>
</ul>
`;
